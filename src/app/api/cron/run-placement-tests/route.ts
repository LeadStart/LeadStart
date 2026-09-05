// GET /app/api/cron/run-placement-tests: every 10 minutes (vercel.json).
//
// Two jobs for the inbox-placement system (migration 00068):
//
//   1) Finalize. Every test still 'awaiting' and past the check delay gets
//      one check pass (src/lib/deliverability/placement-runner.ts). The admin
//      page's polling normally completes a test within a minute or two of
//      sending; this pass is the backstop for a closed tab and the only thing
//      that enforces the 30-minute "missing" timeout. A test stuck in
//      'sending' for 15+ minutes (function died mid-send) is failed so it
//      stops blocking new runs for that mailbox.
//
//   2) Schedule. For each org with placement_test_interval_days set, start a
//      NEUTRAL probe for every active mailbox whose latest test is older than
//      the interval (or that has never been tested): at most
//      MAX_SCHEDULED_PER_TICK mailboxes per run, so a big fleet's probes are
//      spread across the hour rather than fired at once. This is what keeps
//      the health score's seed_placement component populated without clicks.
//
// Probe sends are not campaign sends: they're not logged to native_sends and
// don't touch the ramp or the daily cap (see the migration header for why).

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { GmailClient, GmailConfigError } from "@/lib/gmail/client";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import {
  PlacementError,
  checkPlacementTest,
  latestPlacementTests,
  startPlacementTest,
} from "@/lib/deliverability/placement-runner";
import { PLACEMENT_CHECK_DELAY_MS } from "@/lib/deliverability/placement";
import type { NativeMailbox, PlacementTest } from "@/types/app";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FINALIZE_PER_TICK = 10;
const MAX_SCHEDULED_PER_TICK = 2;
const STUCK_SENDING_MS = 15 * 60_000;

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const tally = {
    checked: 0,
    completed: 0,
    stuck_failed: 0,
    scheduled: 0,
    scheduled_skipped: 0,
    errors: 0,
  };

  // Gmail client per org, built lazily and shared by both jobs.
  const gmailByOrg = new Map<string, GmailClient | null>();
  async function gmailFor(organizationId: string): Promise<GmailClient | null> {
    if (!gmailByOrg.has(organizationId)) {
      try {
        gmailByOrg.set(organizationId, await loadGmailClientForOrg(admin, organizationId));
      } catch (err) {
        gmailByOrg.set(organizationId, null);
        if (!(err instanceof GmailConfigError)) {
          console.error("[cron/placement] gmail client load failed:", err);
        }
      }
    }
    return gmailByOrg.get(organizationId) ?? null;
  }

  // ---- 1a) Fail tests stuck in 'sending' ----
  {
    const cutoff = new Date(now - STUCK_SENDING_MS).toISOString();
    const { data: stuck } = await admin
      .from("placement_tests")
      .select("id")
      .eq("status", "sending")
      .lte("started_at", cutoff);
    for (const t of (stuck ?? []) as { id: string }[]) {
      await admin
        .from("placement_tests")
        .update({
          status: "failed",
          error: "The send phase did not complete (timed out), run the test again.",
          completed_at: nowIso,
        })
        .eq("id", t.id);
      tally.stuck_failed += 1;
    }
  }

  // ---- 1b) Check awaiting tests ----
  {
    const readyBefore = new Date(now - PLACEMENT_CHECK_DELAY_MS).toISOString();
    const { data: awaiting, error } = await admin
      .from("placement_tests")
      .select("*")
      .eq("status", "awaiting")
      .lte("sent_at", readyBefore)
      .order("sent_at", { ascending: true })
      .limit(MAX_FINALIZE_PER_TICK);
    if (error) {
      console.error("[cron/placement] awaiting read failed:", error.message);
      tally.errors += 1;
    }
    for (const test of (awaiting ?? []) as PlacementTest[]) {
      try {
        const gmail = await gmailFor(test.organization_id);
        if (!gmail) continue;
        const { completed } = await checkPlacementTest({ admin, test, gmail, now });
        tally.checked += 1;
        if (completed) tally.completed += 1;
      } catch (err) {
        tally.errors += 1;
        console.error(
          `[cron/placement] check failed for test ${test.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // ---- 2) Scheduled neutral probes ----
  {
    const { data: orgRows, error } = await admin
      .from("organizations")
      .select("id, placement_test_interval_days")
      .not("placement_test_interval_days", "is", null)
      .gt("placement_test_interval_days", 0);
    if (error) {
      console.error("[cron/placement] org read failed:", error.message);
      tally.errors += 1;
    }
    let started = 0;
    for (const org of (orgRows ?? []) as { id: string; placement_test_interval_days: number }[]) {
      if (started >= MAX_SCHEDULED_PER_TICK) break;

      // No active seeds → nothing to probe against; don't even load mailboxes.
      const { count: seedCount } = await admin
        .from("seed_inboxes")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .eq("status", "active");
      if (!seedCount) continue;

      const { data: mbRows } = await admin
        .from("native_mailboxes")
        .select("*")
        .eq("organization_id", org.id)
        .eq("status", "active")
        .order("created_at", { ascending: true });
      const mailboxes = (mbRows ?? []) as NativeMailbox[];
      if (mailboxes.length === 0) continue;

      const latest = await latestPlacementTests(
        admin,
        mailboxes.map((m) => m.id),
      );
      const dueBefore = now - org.placement_test_interval_days * 86_400_000;
      // Oldest-tested first so a fleet cycles fairly across ticks.
      const due = mailboxes
        .map((mb) => ({ mb, last: latest.get(mb.id) ?? null }))
        .filter(({ last }) => {
          if (!last) return true;
          if (last.status === "sending" || last.status === "awaiting") return false;
          return Date.parse(last.started_at) <= dueBefore;
        })
        .sort((a, b) => (a.last ? Date.parse(a.last.started_at) : 0) - (b.last ? Date.parse(b.last.started_at) : 0));

      const gmail = await gmailFor(org.id);
      if (!gmail) continue;

      for (const { mb } of due) {
        if (started >= MAX_SCHEDULED_PER_TICK) break;
        try {
          await startPlacementTest({ admin, mailbox: mb, probe: "neutral", triggeredBy: "scheduled", gmail });
          started += 1;
          tally.scheduled += 1;
        } catch (err) {
          if (err instanceof PlacementError) {
            // e.g. every seed is on this mailbox's own domain: nothing to do.
            tally.scheduled_skipped += 1;
            continue;
          }
          tally.errors += 1;
          console.error(
            `[cron/placement] scheduled start failed for ${mb.email_address}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  return NextResponse.json(tally);
}
