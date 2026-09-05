#!/usr/bin/env node
/**
 * Unit tests for the per-contact (cohort) reply rate: the cohort attribution
 * helper + the calculator's single-mode per-contact math and its fallback.
 * No network, no DB. Run: npx tsx scripts/test-cohort-reply-rate.ts
 */
import { computeCohortReplies } from "../src/lib/kpi/cohort.ts";
import { calculateMetrics } from "../src/lib/kpi/calculator.ts";
import type { CampaignSnapshot } from "../src/types/app.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

// ---- computeCohortReplies ----
console.log("computeCohortReplies");
{
  const sends = [
    { sent_at: "2026-08-01T14:00:00Z", step_index: 0, to_email: "a@x.com" },
    { sent_at: "2026-08-01T15:00:00Z", step_index: 0, to_email: "b@x.com" },
    { sent_at: "2026-08-02T15:00:00Z", step_index: 0, to_email: "c@x.com" },
    { sent_at: "2026-08-03T15:00:00Z", step_index: 1, to_email: "a@x.com" }, // follow-up, not first touch
  ];
  const replies = [
    { lead_email: "A@x.com" }, // case-insensitive, first-touched day1
    { lead_email: "a@x.com" }, // same contact replied again: must count once
    { lead_email: "c@x.com" }, // first-touched day2
    { lead_email: "ghost@x.com" }, // replied but no first-touch send on record: skip
  ];
  const m = computeCohortReplies(sends, replies);
  eq(m.get("2026-08-01"), 1, "day1 cohort = 1 (A, deduped across 2 replies; B never replied)");
  eq(m.get("2026-08-02"), 1, "day2 cohort = 1 (C)");
  eq(m.get("2026-08-03"), undefined, "no cohort credited to a follow-up day");
  eq([...m.values()].reduce((a, b) => a + b, 0), 2, "total cohort repliers = 2 (ghost skipped)");
}
{
  // Re-enrolled contact: two step-0 sends on different days → earliest wins.
  const sends = [
    { sent_at: "2026-08-05T10:00:00Z", step_index: 0, to_email: "z@x.com" },
    { sent_at: "2026-08-01T10:00:00Z", step_index: 0, to_email: "z@x.com" },
  ];
  const m = computeCohortReplies(sends, [{ lead_email: "z@x.com" }]);
  eq(m.get("2026-08-01"), 1, "re-enrolled replier attributes to earliest first-touch day");
  eq(m.get("2026-08-05"), undefined, "not the later first-touch day");
}
{
  eq(computeCohortReplies([], []).size, 0, "empty in → empty out");
}

// ---- calculateMetrics (per-contact) ----
function snap(p: Partial<CampaignSnapshot>): CampaignSnapshot {
  return {
    id: "s", campaign_id: "c", snapshot_date: "2026-08-01", total_leads: 0,
    emails_sent: 0, replies: 0, unique_replies: 0, positive_replies: 0,
    bounces: 0, unsubscribes: 0, meetings_booked: 0, new_leads_contacted: 0,
    reply_rate: null, positive_reply_rate: null, bounce_rate: null,
    unsubscribe_rate: null, raw_data: null, fetched_at: "2026-08-01T00:00:00Z",
    ...p,
  };
}

console.log("calculateMetrics, per-contact reply rate");
{
  // cohort present: 12 cohort repliers / 200 contacts contacted = 6.00%
  const snaps = [
    snap({ emails_sent: 500, new_leads_contacted: 120, cohort_replies: 7, unique_replies: 9 }),
    snap({ emails_sent: 400, new_leads_contacted: 80, cohort_replies: 5, unique_replies: 6, snapshot_date: "2026-08-02" }),
  ];
  const m = calculateMetrics(snaps);
  eq(m.reply_rate, 6, "reply_rate = cohort_replies(12) / contacts(200) = 6.00%");
}
{
  // fallback: cohort_replies absent/0 → use unique_replies (15 / 200 = 7.50%)
  const snaps = [
    snap({ emails_sent: 500, new_leads_contacted: 120, unique_replies: 9 }),
    snap({ emails_sent: 400, new_leads_contacted: 80, unique_replies: 6, snapshot_date: "2026-08-02" }),
  ];
  const m = calculateMetrics(snaps);
  eq(m.reply_rate, 7.5, "fallback to unique_replies(15) / contacts(200) = 7.50% when cohort not populated");
}
{
  // windowed cohort: one day, 3 repliers / 50 contacts = 6.00%
  const m = calculateMetrics([snap({ new_leads_contacted: 50, cohort_replies: 3, unique_replies: 4, emails_sent: 200 })]);
  eq(m.reply_rate, 6, "single-window cohort rate honest (3/50)");
}
{
  // positive_reply_rate keeps the unique_replies denominator (unchanged by cohort)
  const m = calculateMetrics([snap({ new_leads_contacted: 100, cohort_replies: 8, unique_replies: 10, positive_replies: 4, emails_sent: 300, bounces: 6 })]);
  eq(m.positive_reply_rate, 40, "positive_reply_rate = positive(4)/unique(10) = 40% (not cohort-based)");
  eq(m.bounce_rate, 2, "bounce_rate = bounces(6)/sent(300) = 2.00%");
  eq(m.reply_rate, 8, "reply_rate still cohort-based (8/100)");
}
{
  eq(calculateMetrics([snap({ new_leads_contacted: 0, cohort_replies: 0, unique_replies: 0 })]).reply_rate, 0, "no contacts → 0% (no divide-by-zero)");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n  " + failures.join("\n  "));
  process.exit(1);
}
