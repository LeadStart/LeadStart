// Orchestrator: given a freshly-classified hot LeadReply, send the
// notification email and stamp the row with notified_at + token hash.
//
// Flow:
//   1. Sign a one-shot token for this reply.
//   2. Build the email (subject + html) with dossier URL baked in.
//   3. Send via Resend.
//   4. On success, write notified_at + notification_token_hash +
//      notification_email_id to lead_replies.
//
// Idempotency is handled by the caller (webhook handler, commit #6) — this
// function no-ops if the row already has notified_at set, but the authoritative
// dedupe lives upstream where we hold the row lock.

import type { LeadReply } from "@/types/app";
import type { createAdminClient } from "@/lib/supabase/admin";
import { signReplyUrl } from "@/lib/security/signed-urls";
import {
  buildClientNotificationEmail,
  classLabelFor,
} from "./client-email";
import {
  sendViaResend,
  MissingResendKeyError as ResendKeyMissingError,
  RateLimitedError,
  TransientResendError,
  PermanentResendError,
} from "./resend-client";
import { enqueueOwnerAlert } from "./owner-alerts";

// retry_count sentinel that parks a row permanently — above the retry cron's
// MAX_RETRIES threshold (5), so it stays visible to admins but isn't picked
// up for another attempt.
const PERMANENT_FAIL_RETRY_COUNT = 99;

// Mirror of MAX_RETRIES in src/app/api/cron/retry-notifications/route.ts.
// When notification_retry_count reaches this value the retry cron stops
// picking the row up, so this is the terminal state for transient failures
// (the Permanent path uses PERMANENT_FAIL_RETRY_COUNT). Kept duplicated
// rather than imported to avoid a server-route import inside a lib module.
const RETRY_BUDGET = 5;

// Truncate the reply body for the email preview. Long chains with quoted
// history would explode the email; this keeps it scannable.
const PREVIEW_MAX_CHARS = 600;

function truncateForPreview(body: string | null): string {
  if (!body) return "(no body)";
  const trimmed = body.trim();
  if (trimmed.length <= PREVIEW_MAX_CHARS) return trimmed;
  return trimmed.slice(0, PREVIEW_MAX_CHARS).replace(/\s+\S*$/, "") + "…";
}

function requireAppUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL is not set — needed to build the dossier deep-link."
    );
  }
  return url.replace(/\/$/, "");
}

// Preserved so downstream imports keep working. The wrapper's own
// MissingResendKeyError is what we actually throw now; this alias exists
// purely to avoid churning callers.
export { ResendKeyMissingError as MissingResendKeyError };

export interface HotLeadNotificationContext {
  /** The full lead_replies row we just classified. */
  reply: LeadReply;
  /** From clients.notification_email — the address we're emailing. */
  clientNotificationEmail: string;
  /** From clients.notification_cc_emails — extra teammates to keep in the loop. */
  clientNotificationCcEmails?: string[];
}

export interface HotLeadNotificationResult {
  /** Resend message id on success, null if skipped (already notified). */
  resendId: string | null;
  /** The hash stored on the row; null if skipped. */
  tokenHash: string | null;
  skipped: boolean;
}

/**
 * Send the hot-lead email for a single reply, then stamp the row.
 *
 * Throws on unrecoverable failure (missing env, Resend error). The webhook
 * handler in commit #6 catches and logs — we don't retry silently because
 * a stuck notification is observably worse than a visible error.
 */
export async function sendHotLeadNotification(
  ctx: HotLeadNotificationContext,
  admin: ReturnType<typeof createAdminClient>
): Promise<HotLeadNotificationResult> {
  const { reply, clientNotificationEmail, clientNotificationCcEmails } = ctx;
  // Filter out empty / duplicate / equal-to-primary CC entries so Resend
  // doesn't reject and we don't double-deliver to the primary recipient.
  const ccList = (clientNotificationCcEmails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e !== clientNotificationEmail.trim().toLowerCase());
  const ccDedup = Array.from(new Set(ccList));

  if (reply.notified_at) {
    return { resendId: null, tokenHash: reply.notification_token_hash, skipped: true };
  }

  // 1. Sign. Token + hash are bound to this reply.id for the next 4h.
  const { token, hash } = signReplyUrl(reply.id);

  // 2. Build the URLs. NEXT_PUBLIC_APP_URL already includes the /app basePath
  //    (see .env.example), so we append the client route directly.
  //    - dossierUrl: short-lived signed URL, works without login (mobile tap)
  //    - portalUrl:  same route minus the token — permanent, requires login.
  //      Middleware redirects unauthenticated hits to /login?next=… so the
  //      client lands on this reply after signing in.
  const baseUrl = requireAppUrl();
  const replyPath = `/client/inbox/${reply.id}`;
  const dossierUrl = `${baseUrl}${replyPath}?token=${encodeURIComponent(token)}`;
  const portalUrl = `${baseUrl}${replyPath}`;

  // 3. Build the email.
  const { subject, html } = buildClientNotificationEmail({
    leadName: reply.lead_name,
    leadCompany: reply.lead_company,
    leadPhone: reply.lead_phone_e164,
    classLabel: classLabelFor(reply.final_class),
    replyBodyPreview: truncateForPreview(reply.body_text),
    dossierUrl,
    portalUrl,
    receivedAt: reply.received_at,
  });

  const attemptAt = new Date().toISOString();

  // 4. Send via the throttled wrapper. On typed error, stamp retry state
  //    and rethrow so the caller can log / decide. On success, stamp the
  //    notified_* fields + mark status='sent' so the retry cron skips.
  try {
    const { id: resendId } = await sendViaResend({
      from: process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>",
      to: clientNotificationEmail,
      cc: ccDedup.length > 0 ? ccDedup : undefined,
      subject,
      html,
    });

    // 5. Stamp the row. If this write fails, the email is already out, but
    //    the row won't reflect it — next run will detect notified_at is null
    //    and may re-send. Acceptable because duplicates land at the same
    //    inbox, not at a prospect.
    const { error: updateError } = await admin
      .from("lead_replies")
      .update({
        notified_at: attemptAt,
        notification_status: "sent",
        notification_last_attempt_at: attemptAt,
        notification_last_error: null,
        notification_token_hash: hash,
        notification_email_id: resendId,
      })
      .eq("id", reply.id);

    if (updateError) {
      // Surface so the caller logs it — email went out, row didn't record.
      console.error(
        `[send-hot-lead] Email sent (${resendId}) but DB stamp failed for reply ${reply.id}:`,
        updateError,
      );
    }

    return { resendId, tokenHash: hash, skipped: false };
  } catch (err) {
    // Typed errors from the wrapper map onto retry state. Anything else
    // (including non-Error throws) we treat as transient — retrying is
    // safer than silently dropping a hot-lead email.
    const isPermanent = err instanceof PermanentResendError;
    const isRateLimited = err instanceof RateLimitedError;
    const isTransient = err instanceof TransientResendError || isRateLimited;
    const isKnown = isPermanent || isTransient;

    if (err instanceof ResendKeyMissingError) {
      // Don't stamp retry state; missing key is a config error, not a
      // per-row failure. Callers should fix env and redeploy.
      throw err;
    }

    const currentRetryCount = reply.notification_retry_count ?? 0;
    const nextRetryCount = isPermanent
      ? PERMANENT_FAIL_RETRY_COUNT
      : currentRetryCount + 1;
    const errorMessage = err instanceof Error ? err.message : String(err);

    const { error: stampError } = await admin
      .from("lead_replies")
      .update({
        notification_status: "failed",
        notification_retry_count: nextRetryCount,
        notification_last_attempt_at: attemptAt,
        notification_last_error: errorMessage.slice(0, 1000),
      })
      .eq("id", reply.id);

    if (stampError) {
      console.error(
        `[send-hot-lead] Failed to stamp retry state on reply ${reply.id}:`,
        stampError,
      );
    }

    // Persistent-failure alert: fire on Permanent (one-shot, parks at 99)
    // and on the moment the transient retry budget is exhausted (count
    // crosses RETRY_BUDGET). Earlier transient retries stay silent — the
    // retry cron will keep trying and most resolve on their own.
    const exhaustedRetries =
      !isPermanent && nextRetryCount >= RETRY_BUDGET;
    if (isPermanent || exhaustedRetries) {
      try {
        await enqueueOwnerAlert({
          admin,
          kind: "hot_lead_persistent_failure",
          subject: `Hot-lead notification permanently failed for reply ${reply.id}`,
          summary:
            (isPermanent
              ? "Resend rejected the send (permanent error). "
              : `Retry budget exhausted (${nextRetryCount}/${RETRY_BUDGET}). `) +
            `Client will not be notified about this reply.`,
          context: {
            reply_id: reply.id,
            client_id: reply.client_id ?? "(no client)",
            recipient: clientNotificationEmail,
            final_class: reply.final_class ?? "(none)",
            error: errorMessage.slice(0, 500),
            failure_mode: isPermanent ? "permanent" : "retries_exhausted",
          },
        });
      } catch (alertErr) {
        // Never let alert-path failure mask the original throw below.
        console.error(
          `[send-hot-lead] enqueueOwnerAlert failed for reply ${reply.id}:`,
          alertErr,
        );
      }
    }

    if (!isKnown) {
      // Wrap so upstream callers can still distinguish retryable from not.
      // Default to treating as transient because the wrapper already bucketed
      // unknown SDK errors that way — we shouldn't be stricter here.
      throw new TransientResendError(errorMessage);
    }
    throw err;
  }
}
