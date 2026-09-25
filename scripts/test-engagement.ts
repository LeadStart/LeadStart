#!/usr/bin/env node
/**
 * Unit tests for src/lib/deliverability/engagement.ts: the per-contact cohort
 * math behind the inbox-health reply-rate + opt-out signals, and poissonCdf.
 * No network, no DB.
 *
 * Checks the app-wide reply-rate definition is honored (contacts identified by
 * email, attributed to their EARLIEST first email, any reply counts, opt-out =
 * 'unsubscribe') plus the fixed 14-day exposure and the recent/baseline windows.
 *
 * Usage:
 *   npx tsx scripts/test-engagement.ts
 */

import {
  computeContactEngagement,
  poissonCdf,
  ENGAGEMENT_EXPOSURE_DAYS,
  ENGAGEMENT_COHORT_DAYS,
  ENGAGEMENT_BASELINE_DAYS,
  type EngagementReplyRow,
  type FirstTouchRow,
} from "../src/lib/deliverability/engagement.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

// now = Sep 25 → recent window Aug 14–Sep 11, baseline May 16–Aug 14.
const NOW = Date.parse("2026-09-25T17:00:00Z");
const touch = (email: string, day: string, domain: string): FirstTouchRow => ({
  to_email: email,
  sent_at: `${day}T15:00:00Z`,
  domain,
});
const reply = (email: string, day: string, cls = "true_interest"): EngagementReplyRow => ({
  lead_email: email,
  received_at: `${day}T18:00:00Z`,
  final_class: cls,
});

console.log(`\n■ windows: exposure ${ENGAGEMENT_EXPOSURE_DAYS}d, recent ${ENGAGEMENT_COHORT_DAYS}d, baseline ${ENGAGEMENT_BASELINE_DAYS}d`);
{
  const touches: FirstTouchRow[] = [
    touch("a@x.com", "2026-08-20", "d1.com"), // recent, replies in 5 days → counted
    touch("b@x.com", "2026-08-20", "d1.com"), // recent, replies after 21 days → NOT counted
    touch("c@x.com", "2026-08-21", "d2.com"), // recent on d2, opts out next day
    touch("d@x.com", "2026-07-06", "d1.com"), // baseline, replies in 2 days
    touch("e@x.com", "2026-09-20", "d1.com"), // too young (< 14 days) → excluded
    touch("f@x.com", "2026-04-01", "d1.com"), // older than the baseline window → excluded
    touch("g@x.com", "2026-07-10", "d2.com"), // re-enrolled: earliest (Jul 10) wins → baseline
    touch("g@x.com", "2026-08-25", "d1.com"),
    touch("Mixed@Example.com", "2026-07-15", "D1.com"), // case-insensitive email + domain
  ];
  const replies: EngagementReplyRow[] = [
    reply("a@x.com", "2026-08-25"),
    reply("b@x.com", "2026-09-10"),
    reply("c@x.com", "2026-08-22", "unsubscribe"),
    reply("d@x.com", "2026-07-08"),
    reply("e@x.com", "2026-09-21"),
    reply("mixed@example.com", "2026-07-16", "ooo"), // an auto-reply counts, as in the app
    reply("zzz@x.com", "2026-08-30"), // never emailed → ignored
  ];
  const get = computeContactEngagement(touches, replies, NOW);
  const d1 = get("d1.com");
  const d2 = get("D2.COM");
  assert(d1.cohortFrom === "2026-08-14" && d1.cohortTo === "2026-09-11", `recent window Aug 14–Sep 11 (got ${d1.cohortFrom}–${d1.cohortTo})`);
  assert(d1.recent.contacts === 2, `d1 recent = a + b (got ${d1.recent.contacts}); e too young, g attributed to Jul 10`);
  assert(d1.recent.replied === 1, `only a replied within 14 days (got ${d1.recent.replied})`);
  assert(d2.recent.contacts === 1 && d2.recent.replied === 1 && d2.recent.optedOut === 1, "d2: c opted out → replied + opted out");
  assert(d1.baseline.contacts === 3, `baseline = d + g + Mixed (got ${d1.baseline.contacts}); f is too old`);
  assert(d1.baseline.replied === 2, `baseline repliers = d + Mixed (auto-reply counts) (got ${d1.baseline.replied})`);
  assert(d1.baseline.contacts === d2.baseline.contacts, "the baseline is org-wide (same for every domain)");
  const d3 = get("never-sent.com");
  assert(d3.recent.contacts === 0 && d3.baseline.contacts === 3, "a domain with no recent contacts → zeros, baseline still there");
}

console.log("\n■ a reply dated before the first email is not counted");
{
  const get = computeContactEngagement(
    [touch("x@y.com", "2026-08-20", "d.com")],
    [reply("x@y.com", "2026-08-10")],
    NOW,
  );
  assert(get("d.com").recent.replied === 0, "pre-dated reply ignored");
}

console.log("\n■ poissonCdf");
{
  const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
  assert(near(poissonCdf(0, 1), Math.exp(-1)), `P(X<=0|1) = e^-1 (got ${poissonCdf(0, 1)})`);
  assert(near(poissonCdf(2, 2), 5 * Math.exp(-2)), `P(X<=2|2) = 5e^-2 (got ${poissonCdf(2, 2)})`);
  const big = poissonCdf(480, 500);
  assert(big > 0.17 && big < 0.21, `large lambda doesn't underflow: P(X<=480|500) ≈ 0.19 (got ${big.toFixed(4)})`);
  assert(poissonCdf(1, 18.4) < 1e-6, `August davidcabrera: P(X<=1|18.4) < 1e-6 (got ${poissonCdf(1, 18.4).toExponential(2)})`);
  assert(poissonCdf(3, 0) === 1 && poissonCdf(-1, 5) === 0, "edge cases: lambda 0 → 1, k < 0 → 0");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
