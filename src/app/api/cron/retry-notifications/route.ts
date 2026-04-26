// GET /app/api/cron/retry-notifications — scheduled every 10 min via vercel.json.
//
// Picks up lead_replies rows where a previous sendHotLeadNotification attempt
// hit a transient failure (Resend 429 / 5xx / unknown SDK error) and drives
// them toward either success or permanent-fail-parked. Exponential backoff
// keyed on notification_retry_count — first retry waits 1 min since last
// attempt, then 2, 4, 8, 16. After 5 retries the row stays `failed` with
// retry_count below the parked sentinel (PERMANENT_FAIL_RETRY_COUNT = 99 in
// send-hot-lead), and nothing picks it up again — that's the terminal state.
//
// Stale-retry guards: we skip rows whose reply has been handled since the
// original notification attempt (status in sent/resolved/expired/rejected),
// or whose classifier class has been reclassified off the client's
// auto_notify_classes, or whose client is missing a notification_email.
// This prevents "client handled it yesterday, retry email fires today."

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { sendHotLeadNotification } from "@/lib/notifications/send-hot-lead";
import type { LeadReply, Client } from "@/types/app";

const MAX_RETRIES = 5;
// Per-run cap. Keeps a single cron invocation from monopolising the Resend
// rate budget if something has produced a large failure backlog.
const BATCH_LIMIT = 50;

function backoffWaitMs(retryCount: number): number {
  // retry_count starts at 1 after the first failed attempt. Waits: 1, 2,
  // 4, 8, 16 minutes for counts 1..5.
  const exp = Math.max(0, retryCount - 1);
  return Math.pow(2, exp) * 60 * 1000;
}

// Statuses where the reply has moved past "waiting on a notification" —
// we must not send a retry. Everything else (new, classified) is still in
// the "hot lead not yet actioned" window.
const STALE_REPLY_STATUSES = new Set(["sent", "resolved", "expired", "rejected"]);

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const nowMs = Date.now();

  // Candidates: rows previously attempted and parked in 'failed', still
  // inside the retry budget, still linked to a client (orphans without
  // client_id get picked up by B3's link flow), not yet delivered.
  const { data: candidates, error: candidatesError } = await admin
    .from("lead_replies")
    .select(
      "id, notification_retry_count, notification_last_attempt_at, notified_at, final_class, client_id, status",
    )
    .eq("notification_status", "failed")
    .lt("notification_retry_count", MAX_RETRIES)
    .is("notified_at", null)
    .not("client_id", "is", null)
    .not("final_class", "is", null)
    .order("notification_last_attempt_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (candidatesError) {
    console.error("[retry-notifications] query failed:", candidatesError);
    return NextResponse.json(
      { error: candidatesError.message },
      { status: 500 },
    );
  }

  const attempted: Array<{ id: string; outcome: "sent" | "failed"; error?: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const c of candidates || []) {
    const row = c as {
      id: string;
      notification_retry_count: number;
      notification_last_attempt_at: string | null;
      status: string;
      client_id: string | null;
      final_class: string | null;
    };

    // Client-side stale-status check (the DB query can't express NOT IN
    // for a partial list concisely on the supabase-js builder).
    if (STALE_REPLY_STATUSES.has(row.status)) {
      skipped.push({ id: row.id, reason: `stale_status:${row.status}` });
      continue;
    }

    // Exp-backoff gate.
    const lastMs = row.notification_last_attempt_at
      ? new Date(row.notification_last_attempt_at).getTime()
      : 0;
    const waitMs = backoffWaitMs(row.notification_retry_count);
    if (nowMs - lastMs < waitMs) {
      skipped.push({ id: row.id, reason: "backoff" });
      continue;
    }

    // Full-row fetch for the sender.
    const { data: replyData } = await admin
      .from("lead_replies")
      .select("*")
      .eq("id", row.id)
      .maybeSingle();
    if (!replyData) {
      skipped.push({ id: row.id, reason: "reply_vanished" });
      continue;
    }
    const reply = replyData as unknown as LeadReply;

    // Client-side guards: do not re-notify if the reply's been moved out
    // of the notifiable set by a reclassify, or the client lost its
    // notification_email since the original attempt.
    if (!reply.client_id) {
      skipped.push({ id: row.id, reason: "client_id_cleared" });
      continue;
    }
    const { data: clientData } = await admin
      .from("clients")
      .select("*")
      .eq("id", reply.client_id)
      .maybeSingle();
    if (!clientData) {
      skipped.push({ id: row.id, reason: "client_missing" });
      continue;
    }
    const client = clientData as unknown as Client;

    if (!client.notification_email) {
      skipped.push({ id: row.id, reason: "no_notification_email" });
      continue;
    }
    const autoNotify = client.auto_notify_classes || [];
    if (!reply.final_class || !autoNotify.includes(reply.final_class)) {
      skipped.push({ id: row.id, reason: "reclassified_out" });
      continue;
    }

    // Attempt. sendHotLeadNotification stamps retry state itself on both
    // success and failure, so we just log the outcome.
    try {
      await sendHotLeadNotification(
        {
          reply,
          clientNotificationEmail: client.notification_email,
          clientNotificationCcEmails: client.notification_cc_emails ?? [],
        },
        admin,
      );
      attempted.push({ id: row.id, outcome: "sent" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[retry-notifications] send failed for reply ${row.id}:`,
        err,
      );
      attempted.push({ id: row.id, outcome: "failed", error: msg });
    }
  }

  return NextResponse.json({
    considered: (candidates || []).length,
    attempted: attempted.length,
    skipped: skipped.length,
    details: { attempted, skipped },
  });
}
