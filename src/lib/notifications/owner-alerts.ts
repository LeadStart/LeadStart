// Owner-alert queue: enqueue failure events, drain on a 5-min cron into one
// digest email to every profile where role = 'owner'.
//
// Why a queue instead of fire-and-forget per failure:
//   - Coalesces bursts. If a single hourly send-reports cron fails for 8
//     clients in the same run, the operator gets one email summarising the
//     8, not 8 separate ones in the same minute.
//   - Survives transient Resend outages. If the digest send fails, sent_at
//     stays NULL and the next 5-min cron retries — alert events aren't lost
//     to a momentary Resend hiccup.
//   - Decouples the failing path from the alerting path. A bug in the alert
//     formatter can't break the cron whose failure we're trying to report;
//     we just log + carry on.
//
// Recipient resolution lives in the DB (profiles WHERE role = 'owner') so
// rotating owners doesn't need a redeploy. If no owner profiles exist we
// log and skip the send — owners can still read the queue in the admin UI
// once we build that view.
//
// Severity policy (not enforced here — enforced at the call sites):
// alerts only fire on hard bounces, complaints, and persistent failures.
// Soft bounces and transient errors stay silent because Resend retries
// soft bounces internally and the hot-lead retry cron handles transient
// send errors.

import type { createAdminClient } from "@/lib/supabase/admin";
import {
  sendViaResend,
  MissingResendKeyError,
  RateLimitedError,
  TransientResendError,
  PermanentResendError,
} from "./resend-client";

export type OwnerAlertKind =
  | "report_send_error"
  | "email_hard_bounce"
  | "email_complaint"
  | "hot_lead_persistent_failure";

export interface OwnerAlertInput {
  admin: ReturnType<typeof createAdminClient>;
  kind: OwnerAlertKind;
  subject: string;
  /** One-line plain text describing the event; used in the digest. */
  summary: string;
  /** Optional structured details surfaced in the digest body. */
  context?: Record<string, unknown>;
}

interface OwnerAlertRow {
  id: string;
  kind: OwnerAlertKind;
  subject: string;
  body_html: string;
  context: Record<string, unknown>;
  created_at: string;
}

/**
 * Insert one alert event into the queue. Failures are logged and swallowed —
 * we never want a broken alert path to mask the original failure that
 * triggered it.
 */
export async function enqueueOwnerAlert(input: OwnerAlertInput): Promise<void> {
  const { admin, kind, subject, summary, context } = input;
  const bodyHtml = renderEventCard({ kind, summary, context: context ?? {} });

  const { error } = await admin.from("owner_alerts").insert({
    kind,
    subject,
    body_html: bodyHtml,
    context: context ?? {},
  });

  if (error) {
    console.error(
      `[owner-alerts] Failed to enqueue alert (${kind}): ${error.message}. ` +
        `Original event summary: ${summary}`,
    );
  }
}

/**
 * SELECT the email column from every owner profile. Returns deduped, lowercased
 * addresses. Used by the dispatcher; exported so other call sites (e.g. a
 * future admin UI test-send) can reuse the same recipient set.
 */
export async function getOwnerRecipients(
  admin: ReturnType<typeof createAdminClient>,
): Promise<string[]> {
  const { data, error } = await admin
    .from("profiles")
    .select("email")
    .eq("role", "owner");

  if (error) {
    console.error("[owner-alerts] Failed to load owner profiles:", error);
    return [];
  }
  const emails = (data ?? [])
    .map((r) => (r as { email: string | null }).email)
    .filter((e): e is string => !!e && e.includes("@"))
    .map((e) => e.trim().toLowerCase());
  return Array.from(new Set(emails));
}

interface DispatchResult {
  pending: number;
  sent: number;
  recipients: string[];
  skipped_reason?: string;
}

/**
 * Drain pending alerts into a single digest email. Called from
 * /api/cron/dispatch-owner-alerts every 5 minutes.
 *
 * Sequencing:
 *   1. SELECT all rows where sent_at IS NULL, oldest first.
 *   2. If none, return early.
 *   3. Build digest HTML. Send to all owner emails.
 *   4. On success, UPDATE sent_at on every row in the digest.
 *   5. On Resend failure, leave sent_at NULL. Next cron retries.
 *
 * The send → stamp window is the only place an alert can theoretically
 * double-deliver: if step 3 succeeds but step 4 fails, the next cron picks
 * the same rows up and re-sends. We accept that — better a duplicate alert
 * than a missed one.
 */
export async function dispatchPendingOwnerAlerts(
  admin: ReturnType<typeof createAdminClient>,
): Promise<DispatchResult> {
  const { data: pendingRows, error: selectError } = await admin
    .from("owner_alerts")
    .select("id, kind, subject, body_html, context, created_at")
    .is("sent_at", null)
    .order("created_at", { ascending: true });

  if (selectError) {
    console.error("[owner-alerts] dispatcher select failed:", selectError);
    return { pending: 0, sent: 0, recipients: [], skipped_reason: "select_failed" };
  }

  const rows = (pendingRows ?? []) as unknown as OwnerAlertRow[];
  if (rows.length === 0) {
    return { pending: 0, sent: 0, recipients: [] };
  }

  const recipients = await getOwnerRecipients(admin);
  if (recipients.length === 0) {
    console.error(
      `[owner-alerts] ${rows.length} alerts pending but no owner profiles found — leaving in queue.`,
    );
    return {
      pending: rows.length,
      sent: 0,
      recipients: [],
      skipped_reason: "no_owner_recipients",
    };
  }

  if (!process.env.RESEND_API_KEY) {
    console.error(
      `[owner-alerts] RESEND_API_KEY not set — ${rows.length} alerts left in queue.`,
    );
    return {
      pending: rows.length,
      sent: 0,
      recipients,
      skipped_reason: "missing_resend_key",
    };
  }

  const subject = buildDigestSubject(rows);
  const html = buildDigestHtml(rows);
  const fromAddress =
    process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>";

  try {
    await sendViaResend({
      from: fromAddress,
      to: recipients,
      subject,
      html,
    });
  } catch (err) {
    const cls =
      err instanceof MissingResendKeyError
        ? "MissingResendKey"
        : err instanceof RateLimitedError
          ? "RateLimited"
          : err instanceof TransientResendError
            ? "Transient"
            : err instanceof PermanentResendError
              ? "Permanent"
              : "Unknown";
    console.error(
      `[owner-alerts] Digest send failed (${cls}); ${rows.length} alerts left in queue:`,
      err,
    );
    return {
      pending: rows.length,
      sent: 0,
      recipients,
      skipped_reason: `resend_failed:${cls}`,
    };
  }

  const ids = rows.map((r) => r.id);
  const stampedAt = new Date().toISOString();
  const { error: updateError } = await admin
    .from("owner_alerts")
    .update({ sent_at: stampedAt })
    .in("id", ids);

  if (updateError) {
    // Email is out, sent_at didn't stamp — next cron will resend the same set.
    // Log loudly so the duplicate is explainable in the inbox.
    console.error(
      `[owner-alerts] Digest sent (${ids.length} rows) but sent_at update failed; expect a duplicate digest next run:`,
      updateError,
    );
  }

  return {
    pending: rows.length,
    sent: rows.length,
    recipients,
  };
}


// ── Rendering ───────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KIND_LABEL: Record<OwnerAlertKind, string> = {
  report_send_error: "Report send error",
  email_hard_bounce: "Email hard bounce",
  email_complaint: "Spam complaint",
  hot_lead_persistent_failure: "Hot-lead notification permanently failed",
};

const KIND_COLOR: Record<OwnerAlertKind, string> = {
  report_send_error: "#b91c1c",
  email_hard_bounce: "#b91c1c",
  email_complaint: "#c2410c",
  hot_lead_persistent_failure: "#b91c1c",
};

function renderEventCard(input: {
  kind: OwnerAlertKind;
  summary: string;
  context: Record<string, unknown>;
}): string {
  const { kind, summary, context } = input;
  const color = KIND_COLOR[kind];
  const label = KIND_LABEL[kind];
  const contextRows = Object.entries(context)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#555;">${escapeHtml(k)}</td>` +
        `<td><code>${escapeHtml(String(v))}</code></td></tr>`,
    )
    .join("");
  return `
<div style="border-left:3px solid ${color};padding:8px 12px;margin:0 0 12px;background:#fafafa;">
  <div style="font-size:13px;font-weight:600;color:${color};">${escapeHtml(label)}</div>
  <div style="margin:4px 0 6px;">${escapeHtml(summary)}</div>
  ${contextRows ? `<table style="border-collapse:collapse;font-size:12px;">${contextRows}</table>` : ""}
</div>`.trim();
}

function buildDigestSubject(rows: OwnerAlertRow[]): string {
  if (rows.length === 1) {
    return `[LeadStart alert] ${rows[0].subject}`;
  }
  // Group counts in subject so the inbox preview is informative.
  const counts = new Map<OwnerAlertKind, number>();
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(
    ([k, c]) => `${c}× ${KIND_LABEL[k]}`,
  );
  return `[LeadStart alert] ${rows.length} events: ${parts.join(", ")}`;
}

function buildDigestHtml(rows: OwnerAlertRow[]): string {
  const cards = rows.map((r) => r.body_html).join("\n");
  const firstAt = rows[0].created_at;
  const lastAt = rows[rows.length - 1].created_at;
  const range =
    firstAt === lastAt
      ? escapeHtml(firstAt)
      : `${escapeHtml(firstAt)} — ${escapeHtml(lastAt)}`;

  return `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;max-width:680px;">
  <h2 style="margin:0 0 8px;color:#b91c1c;">LeadStart owner alert</h2>
  <p style="margin:0 0 16px;color:#444;font-size:14px;">
    <strong>${rows.length}</strong> ${rows.length === 1 ? "event" : "events"}
    queued in the last 5-minute window (${range}).
  </p>
  ${cards}
  <p style="margin:16px 0 0;color:#666;font-size:12px;">
    These events failed in a way that won't auto-recover (hard bounces, spam
    complaints, or persistent send failures). Soft bounces and transient
    errors are not included — Resend and the retry cron handle those.
  </p>
</div>`.trim();
}
