// GET /app/api/cron/retry-enrichment — scheduled every 5 min via vercel.json.
//
// Picks up lead_replies rows parked as status='pending_enrichment' by the
// webhook handler (when the in-line 3-attempt getEmail backoff exhausted).
// Tries to enrich via InstantlyClient.getEmail; on success promotes to
// status='new', updates the row with full body/subject/etc, and schedules
// runReplyPipeline so classification + notification fire normally.
//
// Backoff formula matches C1's retry-notifications: 2^(retry_count - 1)
// minutes, max 5 retries. Terminal state is status='enrichment_failed'.

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { InstantlyClient } from "@/lib/instantly/client";
import {
  normalizeReplyFromInstantlyEmail,
  type RawWebhookPayload,
} from "@/lib/replies/ingest";
import { runReplyPipeline } from "@/lib/replies/pipeline";

const MAX_RETRIES = 5;
const BATCH_LIMIT = 25; // Lower than C1's 50 — Instantly's rate limits are stricter than Resend's.

function backoffWaitMs(retryCount: number): number {
  const exp = Math.max(0, retryCount - 1);
  return Math.pow(2, exp) * 60 * 1000;
}

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const nowMs = Date.now();

  const { data: candidates, error: candidatesError } = await admin
    .from("lead_replies")
    .select(
      "id, organization_id, instantly_email_id, enrichment_retry_count, enrichment_last_attempt_at, client_id, campaign_id, raw_payload",
    )
    .eq("status", "pending_enrichment")
    .lt("enrichment_retry_count", MAX_RETRIES)
    .not("instantly_email_id", "is", null)
    .order("enrichment_last_attempt_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_LIMIT);

  if (candidatesError) {
    console.error("[retry-enrichment] query failed:", candidatesError);
    return NextResponse.json(
      { error: candidatesError.message },
      { status: 500 },
    );
  }

  // Group by org so we only fetch each instantly_api_key once per batch.
  const orgIds = Array.from(
    new Set(
      (candidates || []).map(
        (r) => (r as { organization_id: string }).organization_id,
      ),
    ),
  );
  const orgKeys = new Map<string, string | null>();
  if (orgIds.length > 0) {
    const { data: orgs } = await admin
      .from("organizations")
      .select("id, instantly_api_key")
      .in("id", orgIds);
    for (const o of orgs || []) {
      const row = o as { id: string; instantly_api_key: string | null };
      orgKeys.set(row.id, row.instantly_api_key);
    }
  }

  const attempted: Array<{
    id: string;
    outcome: "enriched" | "failed" | "terminal";
    error?: string;
  }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const c of candidates || []) {
    const row = c as {
      id: string;
      organization_id: string;
      instantly_email_id: string | null;
      enrichment_retry_count: number;
      enrichment_last_attempt_at: string | null;
      client_id: string | null;
      campaign_id: string | null;
      raw_payload: Record<string, unknown> | null;
    };

    // Backoff gate.
    const lastMs = row.enrichment_last_attempt_at
      ? new Date(row.enrichment_last_attempt_at).getTime()
      : 0;
    const waitMs = backoffWaitMs(row.enrichment_retry_count);
    if (lastMs > 0 && nowMs - lastMs < waitMs) {
      skipped.push({ id: row.id, reason: "backoff" });
      continue;
    }

    const apiKey = orgKeys.get(row.organization_id);
    if (!apiKey) {
      skipped.push({ id: row.id, reason: "no_api_key" });
      continue;
    }
    if (!row.instantly_email_id) {
      skipped.push({ id: row.id, reason: "no_instantly_email_id" });
      continue;
    }

    const attemptAt = new Date().toISOString();

    try {
      const instantly = new InstantlyClient(apiKey);
      const email = await instantly.getEmail(row.instantly_email_id);

      const normalized = normalizeReplyFromInstantlyEmail(
        email,
        (row.raw_payload ?? {}) as RawWebhookPayload,
        {
          organization_id: row.organization_id,
          client_id: row.client_id,
          campaign_id: row.campaign_id,
        },
      );

      // Promote: fill in the enriched fields + flip status to 'new' so the
      // pipeline picks this up. enrichment_last_attempt_at stays stamped
      // for the audit trail; retry_count stops incrementing because the
      // row has left pending_enrichment.
      const { error: updateError } = await admin
        .from("lead_replies")
        .update({
          ...normalized,
          status: "new",
          enrichment_last_attempt_at: attemptAt,
        })
        .eq("id", row.id);

      if (updateError) {
        console.error(
          `[retry-enrichment] promote update failed for ${row.id}:`,
          updateError,
        );
        attempted.push({
          id: row.id,
          outcome: "failed",
          error: updateError.message,
        });
        continue;
      }

      // Fire the pipeline now that the row is classifiable. Use after() so
      // pipeline work doesn't block the cron's overall response; crons on
      // Vercel run in a request context where after() is supported.
      const replyId = row.id;
      after(async () => {
        try {
          await runReplyPipeline(replyId, admin);
        } catch (err) {
          console.error(
            `[retry-enrichment] runReplyPipeline(${replyId}) threw:`,
            err,
          );
        }
      });

      attempted.push({ id: row.id, outcome: "enriched" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextCount = row.enrichment_retry_count + 1;
      const terminal = nextCount >= MAX_RETRIES;
      const { error: stampError } = await admin
        .from("lead_replies")
        .update({
          enrichment_retry_count: nextCount,
          enrichment_last_attempt_at: attemptAt,
          status: terminal ? "enrichment_failed" : "pending_enrichment",
          error: msg.slice(0, 1000),
        })
        .eq("id", row.id);
      if (stampError) {
        console.error(
          `[retry-enrichment] retry stamp failed for ${row.id}:`,
          stampError,
        );
      }
      attempted.push({
        id: row.id,
        outcome: terminal ? "terminal" : "failed",
        error: msg,
      });
    }
  }

  return NextResponse.json({
    considered: (candidates || []).length,
    attempted: attempted.length,
    skipped: skipped.length,
    details: { attempted, skipped },
  });
}
