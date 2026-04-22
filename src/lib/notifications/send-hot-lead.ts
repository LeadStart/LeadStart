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

export class MissingResendKeyError extends Error {
  constructor() {
    super("RESEND_API_KEY is not set. Cannot send hot-lead notification.");
    this.name = "MissingResendKeyError";
  }
}

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

  if (!process.env.RESEND_API_KEY) {
    throw new MissingResendKeyError();
  }

  // 1. Sign. Token + hash are bound to this reply.id for the next 4h.
  const { token, hash } = signReplyUrl(reply.id);

  // 2. Build the URL. NEXT_PUBLIC_APP_URL already includes the /app basePath
  //    (see .env.example), so we append the client route directly.
  const baseUrl = requireAppUrl();
  const dossierUrl = `${baseUrl}/client/inbox/${reply.id}?token=${encodeURIComponent(token)}`;

  // 3. Build the email.
  const { subject, html } = buildClientNotificationEmail({
    leadName: reply.lead_name,
    leadCompany: reply.lead_company,
    leadPhone: reply.lead_phone_e164,
    classLabel: classLabelFor(reply.final_class),
    replyBodyPreview: truncateForPreview(reply.body_text),
    dossierUrl,
    receivedAt: reply.received_at,
  });

  // 4. Send via Resend. Dynamic import matches the pattern in
  //    src/app/api/cron/send-reports/route.ts.
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>",
    to: clientNotificationEmail,
    cc: ccDedup.length > 0 ? ccDedup : undefined,
    subject,
    html,
  });

  if (error) {
    throw new Error(`Resend failed: ${error.message || JSON.stringify(error)}`);
  }

  const resendId = data?.id ?? null;

  // 5. Stamp the row. If this write fails, the email is already out, but
  //    the row won't reflect it — next run will detect notified_at is null
  //    and may re-send. Acceptable because duplicates land at the same
  //    inbox, not at a prospect.
  const { error: updateError } = await admin
    .from("lead_replies")
    .update({
      notified_at: new Date().toISOString(),
      notification_token_hash: hash,
      notification_email_id: resendId,
    })
    .eq("id", reply.id);

  if (updateError) {
    // Surface so the caller logs it — email went out, row didn't record.
    console.error(
      `[send-hot-lead] Email sent (${resendId}) but DB stamp failed for reply ${reply.id}:`,
      updateError
    );
  }

  return { resendId, tokenHash: hash, skipped: false };
}
