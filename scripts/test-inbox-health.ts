#!/usr/bin/env node
/**
 * Unit tests for src/lib/deliverability/inbox-health.ts: the pure per-mailbox
 * health scorer. No network, no DB; imports the REAL production module by
 * relative path (type-only cross-imports are erased at runtime).
 *
 * Anchors (see the weights table in inbox-health.ts):
 *   - perfect signals            → 100 / healthy  (9 components)
 *   - DBL-listed alone           → 40  / critical
 *   - >10% bounce alone          → 40  / critical
 *   - 3% bounce on 100 sends     → 85  / healthy
 *   - 19 sends                   → bounce unchecked, no deduction
 *   - 30% soft bounce on 100     → 85  / healthy (warn -15, never critical)
 *   - reply rate per contact, Aug vs Jul (real numbers):
 *       davidcabrera 1/316 vs 7/120 → bad -25 (75 / watch alone)
 *       getinicio    5/316 vs 7/120 → warn -10
 *   - opt-outs 5 of 120 (4.2%)   → warn -10; 6 of 632 → ok
 *   - 2 of 3 seeds in spam       → 55  / watch   (bad -45; never critical alone)
 *   - 1 of 4 seeds in spam       → 75  / watch   (bad -25)
 *   - 1 of 3 seeds missing       → 90  / healthy (warn -10)
 *   - Promotions majority        → 95  / healthy (warn -5)
 *   - all seeds in inbox         → ok, detail names receiver auth
 *   - SPF/DMARC/MX truly missing → exactly 50 / watch
 *   - DNS resolver outage        → DNS components unchecked, never critical
 *   - empty inputs               → 100 / healthy, every component unchecked
 *
 * Usage:
 *   npx tsx scripts/test-inbox-health.ts
 */

import {
  computeInboxHealth,
  bandForScore,
  scoreMath,
  HEALTH_RUBRIC,
  HEALTH_SCALE,
  PENALTY,
} from "../src/lib/deliverability/inbox-health.ts";

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
    console.error(`  ✗ ${msg}`);
  }
}

const ok = (detail = "ok") => ({ status: "pass" as const, detail });
const warn = (detail = "warn") => ({ status: "warn" as const, detail });
const bad = (detail = "fail") => ({ status: "fail" as const, detail });
const goodDns = { domain: "example.com", spf: ok(), dkim: ok(), dmarc: ok() };

// ---------- 1. Perfect ----------
console.log("\n■ perfect signals → 100 / healthy");
{
  const r = computeInboxHealth({
    dbl: { status: "clean", detail: "not listed" },
    domainAuth: goodDns,
    mx: ok(),
    bounces: { sent7d: 100, bounced7d: 1 },
  });
  assert(r.score === 100, `score is 100 (got ${r.score})`);
  assert(r.band === "healthy", `band is healthy (got ${r.band})`);
  assert(r.components.length === 10, `all 10 components present (got ${r.components.length})`);
}

// ---------- 2. DBL-listed alone ----------
console.log("\n■ DBL-listed alone → 40 / critical");
{
  const r = computeInboxHealth({
    dbl: { status: "listed", detail: "listed" },
    domainAuth: goodDns,
    mx: ok(),
    bounces: { sent7d: 100, bounced7d: 1 },
  });
  assert(r.score === 40, `score is 40 (got ${r.score})`);
  assert(r.band === "critical", `band is critical (got ${r.band})`);
  const bl = r.components.find((c) => c.key === "blacklist");
  assert(bl?.status === "bad" && bl.deduction === 60, "blacklist component is bad, -60");
}

// ---------- 3. >10% bounce alone ----------
console.log("\n■ >10% bounce alone → 40 / critical");
{
  const r = computeInboxHealth({
    dbl: { status: "clean", detail: "not listed" },
    domainAuth: goodDns,
    mx: ok(),
    bounces: { sent7d: 50, bounced7d: 6 }, // 12%
  });
  assert(r.score === 40, `score is 40 (got ${r.score})`);
  assert(r.band === "critical", `band is critical (got ${r.band})`);
}

// ---------- 4. 3% bounce on 100 ----------
console.log("\n■ 3% bounce on 100 sends → 85 / healthy");
{
  const r = computeInboxHealth({
    dbl: { status: "clean", detail: "not listed" },
    domainAuth: goodDns,
    mx: ok(),
    bounces: { sent7d: 100, bounced7d: 3 },
  });
  assert(r.score === 85, `score is 85 (got ${r.score})`);
  assert(r.band === "healthy", `band is healthy (got ${r.band})`);
}

// ---------- 5. Small sample ----------
console.log("\n■ 19 sends → bounce unchecked, no deduction");
{
  const r = computeInboxHealth({
    dbl: { status: "clean", detail: "not listed" },
    domainAuth: goodDns,
    mx: ok(),
    bounces: { sent7d: 19, bounced7d: 5 },
  });
  const bounce = r.components.find((c) => c.key === "bounce_rate");
  assert(bounce?.status === "unchecked" && bounce.deduction === 0, "bounce is unchecked at 19 sends");
  assert(r.score === 100, `score is 100 (got ${r.score})`);
}

// ---------- 6. Records genuinely missing ----------
console.log("\n■ SPF, DMARC and MX genuinely missing (+ DKIM warn) → exactly 50 / watch");
{
  const r = computeInboxHealth({
    dbl: { status: "unchecked", detail: "no key" },
    domainAuth: { domain: "x.com", spf: bad(), dkim: warn(), dmarc: bad() },
    mx: bad(),
    bounces: null,
  });
  assert(r.score === 50, `score is exactly 50 (got ${r.score})`);
  assert(r.band === "watch", `band is watch (got ${r.band})`);
}

// ---------- 6b. DNS resolver outage ----------
// Before 2026-09-25 a timed-out lookup read as a missing record, so an outage
// scored exactly like case 6 (50), and with the zero-reply -10 → 40 critical.
console.log("\n■ DNS resolver outage (every lookup 'unknown') → 100, all four unchecked");
{
  const unknown = (label: string) => ({ status: "unknown" as const, detail: `Couldn't check ${label} right now` });
  const r = computeInboxHealth({
    domainAuth: { domain: "x.com", spf: unknown("SPF"), dkim: unknown("DKIM"), dmarc: unknown("DMARC") },
    mx: unknown("MX"),
    bounces: { sent7d: 100, bounced7d: 3 },
  });
  const dns = r.components.filter((c) => ["spf", "dkim", "dmarc", "mx"].includes(c.key));
  assert(dns.every((c) => c.status === "unchecked" && c.deduction === 0), "SPF/DKIM/DMARC/MX all unchecked, zero deduction");
  assert(r.score === 85, `only the (real) 3% bounce counts: 85 (got ${r.score})`);
  assert(r.band === "healthy", `never critical from an outage (got ${r.band})`);
}

// ---------- 7. Empty inputs ----------
console.log("\n■ empty inputs → 100 / healthy, every component unchecked");
{
  const r = computeInboxHealth({});
  assert(r.score === 100, `score is 100 (got ${r.score})`);
  assert(r.band === "healthy", `band is healthy (got ${r.band})`);
  assert(
    r.components.every((c) => c.status === "unchecked" && c.deduction === 0),
    "all components unchecked with zero deduction",
  );
}

// ---------- 7a. Soft bounce ----------
console.log("\n■ 30% soft bounce on 100 sends → warn -15 → 85 / healthy");
{
  const r = computeInboxHealth({
    dbl: { status: "clean", detail: "not listed" },
    domainAuth: goodDns,
    mx: ok(),
    bounces: { sent7d: 100, bounced7d: 0, softBounced7d: 30 },
  });
  const soft = r.components.find((c) => c.key === "soft_bounce_rate");
  assert(soft?.status === "warn" && soft.deduction === 15, "soft bounce is warn, -15");
  assert(r.score === 85, `score is 85 (got ${r.score})`);
  assert(r.band === "healthy", `band is healthy, soft bounces never critical alone (got ${r.band})`);
}

console.log("\n■ soft bounce unchecked when softBounced7d omitted");
{
  const r = computeInboxHealth({ bounces: { sent7d: 100, bounced7d: 1 } });
  const soft = r.components.find((c) => c.key === "soft_bounce_rate");
  assert(soft?.status === "unchecked" && soft.deduction === 0, "soft bounce unchecked, no deduction");
}

// ---------- 7b. Reply rate + opt-outs per contact (domain-level) ----------
// [contacts, replied, optedOut] for the domain's recent contacts and the org's
// earlier ones. The first two cases are the real August 2026 numbers (same
// Jul 5 list: July cohort as the baseline, August cohort per domain).
const eng = (recent: [number, number, number], baseline: [number, number, number]) => ({
  domain: "example.com",
  cohortFrom: "2026-08-14",
  cohortTo: "2026-09-10",
  recent: { contacts: recent[0], replied: recent[1], optedOut: recent[2] },
  baseline: { contacts: baseline[0], replied: baseline[1], optedOut: baseline[2] },
});
const replyOf = (r: ReturnType<typeof computeInboxHealth>) => r.components.find((c) => c.key === "reply_signal");
const optOf = (r: ReturnType<typeof computeInboxHealth>) => r.components.find((c) => c.key === "optout_rate");

console.log("\n■ davidcabreraproperties.com, Aug vs Jul: 1 of 316 vs 7 of 120 → bad -25, 'opt-outs fell too'");
{
  const r = computeInboxHealth({ engagement: eng([316, 1, 1], [120, 7, 5]) });
  const rep = replyOf(r);
  assert(rep?.status === "bad" && rep.deduction === 25, `reply rate bad, -25 (got ${rep?.status} -${rep?.deduction})`);
  assert(rep?.detail.includes("1 of 316") === true && rep.detail.includes("5.8%") === true, `detail gives both rates (got: ${rep?.detail})`);
  assert(rep?.detail.includes("less than 0.1%") === true, "detail says how unlikely by chance");
  assert(rep?.detail.includes("Opt-outs fell too") === true, "opt-outs fell with replies → 'not being seen'");
  assert(r.score === 75 && r.band === "watch", `alone → 75 / watch (got ${r.score} / ${r.band})`);
}

console.log("\n■ getiniciopropertysolutions.com, Aug vs Jul: 5 of 316 vs 7 of 120 → warn -10");
{
  const r = computeInboxHealth({ engagement: eng([316, 5, 5], [120, 7, 5]) });
  const rep = replyOf(r);
  assert(rep?.status === "warn" && rep.deduction === 10, `reply rate warn, -10 (got ${rep?.status} -${rep?.deduction})`);
}

console.log("\n■ opt-outs held up while replies fell → the note points at targeting/copy");
{
  const r = computeInboxHealth({ engagement: eng([316, 6, 6], [120, 7, 2]) });
  const rep = replyOf(r);
  assert(rep?.status === "warn", `warn (got ${rep?.status})`);
  assert(rep?.detail.includes("Opt-outs held up") === true, `detail says targeting/copy (got: ${rep?.detail})`);
}

console.log("\n■ no drop → ok; a small dip → ok; a big dip on a tiny sample → ok (chance)");
{
  assert(replyOf(computeInboxHealth({ engagement: eng([200, 10, 2], [400, 20, 5]) }))?.status === "ok", "5% vs 5% → ok");
  assert(replyOf(computeInboxHealth({ engagement: eng([100, 3, 0], [400, 20, 5]) }))?.status === "ok", "3% vs 5% (60% of it) → ok");
  const tiny = replyOf(computeInboxHealth({ engagement: eng([50, 0, 0], [100, 2, 0]) }));
  assert(tiny?.status === "ok", `0 of 50 vs 2% (37% likely by chance) → ok (got ${tiny?.status})`);
}

console.log("\n■ below the sample floors / no earlier replies → unchecked, zero deduction");
{
  const few = computeInboxHealth({ engagement: eng([49, 0, 0], [400, 20, 5]) });
  assert(replyOf(few)?.status === "unchecked" && optOf(few)?.status === "unchecked", "49 recent contacts → both unchecked");
  assert(replyOf(computeInboxHealth({ engagement: eng([200, 0, 0], [99, 5, 0]) }))?.status === "unchecked", "99 earlier contacts → unchecked");
  assert(replyOf(computeInboxHealth({ engagement: eng([200, 0, 0], [300, 0, 0]) }))?.status === "unchecked", "no earlier replies → unchecked");
  assert(computeInboxHealth({ engagement: null }).score === 100, "engagement unreadable → 100, never a false 'no replies'");
}

console.log("\n■ opt-out rate: July's 5 of 120 (4.2%) → warn -10; August's 6 of 632 → ok; 2 of 60 → ok (count floor)");
{
  const july = computeInboxHealth({ engagement: eng([120, 7, 5], [120, 7, 5]) });
  assert(optOf(july)?.status === "warn" && optOf(july)?.deduction === 10, `4.2% → warn -10 (got ${optOf(july)?.status})`);
  assert(optOf(july)?.detail.includes("spam complaints") === true, "detail explains the complaint proxy");
  assert(optOf(computeInboxHealth({ engagement: eng([632, 6, 6], [120, 7, 5]) }))?.status === "ok", "0.9% → ok");
  assert(optOf(computeInboxHealth({ engagement: eng([60, 2, 2], [120, 7, 5]) }))?.status === "ok", "3.3% but only 2 opt-outs → ok");
}

// ---------- 7c. Seed placement ----------
const authOk = { checked: 3, spf_fail: 0, dkim_fail: 0, dmarc_fail: 0 };
const placement = (p: {
  inbox: number;
  promotions?: number;
  spam?: number;
  missing?: number;
  authSummary?: typeof authOk | null;
}) => ({
  testedAt: "2026-08-22T12:00:00Z",
  probe: "neutral" as const,
  seedsTotal: p.inbox + (p.promotions ?? 0) + (p.spam ?? 0) + (p.missing ?? 0),
  inbox: p.inbox,
  promotions: p.promotions ?? 0,
  spam: p.spam ?? 0,
  missing: p.missing ?? 0,
  authSummary: p.authSummary === undefined ? authOk : p.authSummary,
});

console.log("\n■ seed placement: 2 of 3 seeds in spam → bad -45 → 55 / watch");
{
  const r = computeInboxHealth({ placement: placement({ inbox: 1, spam: 2 }) });
  const sp = r.components.find((c) => c.key === "seed_placement");
  assert(sp?.status === "bad" && sp.deduction === 45, "seed placement is bad, -45");
  assert(r.score === 55, `score is 55 (got ${r.score})`);
  assert(r.band === "watch", `band is watch, a bad panel alone never goes critical (got ${r.band})`);
  assert(!!sp && sp.detail.includes("2 of 3 seeds in spam"), `detail names the spam count (got "${sp?.detail}")`);
  assert(!!sp && sp.detail.includes("reputation or content"), "detail says auth passed → reputation/content");
}

console.log("\n■ seed placement: 1 of 4 seeds in spam → bad -25 → 75 / watch");
{
  const r = computeInboxHealth({ placement: placement({ inbox: 3, spam: 1 }) });
  const sp = r.components.find((c) => c.key === "seed_placement");
  assert(sp?.status === "bad" && sp.deduction === 25, "seed placement is bad, -25");
  assert(r.score === 75, `score is 75 (got ${r.score})`);
}

console.log("\n■ seed placement: 1 of 3 missing, none in spam → warn -10 → 90 / healthy");
{
  const r = computeInboxHealth({ placement: placement({ inbox: 2, missing: 1 }) });
  const sp = r.components.find((c) => c.key === "seed_placement");
  assert(sp?.status === "warn" && sp.deduction === 10, "seed placement is warn, -10");
  assert(r.score === 90, `score is 90 (got ${r.score})`);
  assert(!!sp && sp.detail.includes("1 of 3 seeds missing"), "detail names the missing count");
}

console.log("\n■ seed placement: Promotions majority → warn -5 → 95 / healthy");
{
  const r = computeInboxHealth({ placement: placement({ inbox: 1, promotions: 2 }) });
  const sp = r.components.find((c) => c.key === "seed_placement");
  assert(sp?.status === "warn" && sp.deduction === 5, "seed placement is warn, -5");
  assert(r.score === 95, `score is 95 (got ${r.score})`);
  assert(!!sp && sp.detail.includes("Promotions"), "detail mentions Promotions");
}

console.log("\n■ seed placement: all inbox → ok, no deduction, detail names receiver auth");
{
  const r = computeInboxHealth({ placement: placement({ inbox: 3 }) });
  const sp = r.components.find((c) => c.key === "seed_placement");
  assert(sp?.status === "ok" && sp.deduction === 0, "seed placement ok, no deduction");
  assert(!!sp && sp.detail.startsWith("3 of 3 seeds in the inbox"), `detail leads with the inbox count (got "${sp?.detail}")`);
  assert(!!sp && sp.detail.includes("SPF/DKIM/DMARC passed"), "detail reports receiver auth passed");
}

console.log("\n■ seed placement: receiver-side DKIM failure is named in the detail");
{
  const r = computeInboxHealth({
    placement: placement({ inbox: 0, spam: 3, authSummary: { checked: 3, spf_fail: 0, dkim_fail: 3, dmarc_fail: 3 } }),
  });
  const sp = r.components.find((c) => c.key === "seed_placement");
  assert(sp?.status === "bad" && sp.deduction === 45, "all-spam is bad, -45");
  assert(!!sp && sp.detail.includes("DKIM failed at 3 of 3"), `detail names the DKIM failure (got "${sp?.detail}")`);
  assert(!!sp && sp.detail.includes("fix authentication"), "detail tells the operator to fix auth first");
}

console.log("\n■ seed placement omitted / no readable seeds → unchecked, no deduction");
{
  const r1 = computeInboxHealth({});
  const sp1 = r1.components.find((c) => c.key === "seed_placement");
  assert(sp1?.status === "unchecked" && sp1.deduction === 0, "omitted → unchecked");
  const r2 = computeInboxHealth({ placement: placement({ inbox: 0 }) });
  const sp2 = r2.components.find((c) => c.key === "seed_placement");
  assert(sp2?.status === "unchecked" && sp2.deduction === 0, "zero readable seeds → unchecked");
  assert(r2.score === 100, `score stays 100 (got ${r2.score})`);
}

// ---------- 8. Band boundaries ----------
console.log("\n■ band boundaries");
{
  assert(bandForScore(100) === "healthy", "100 → healthy");
  assert(bandForScore(80) === "healthy", "80 → healthy");
  assert(bandForScore(79) === "watch", "79 → watch");
  assert(bandForScore(50) === "watch", "50 → watch");
  assert(bandForScore(49) === "critical", "49 → critical");
  assert(bandForScore(0) === "critical", "0 → critical");
}

// ---------- 9. In-app rubric + score math ----------
// The Mailboxes page renders HEALTH_RUBRIC and scoreMath(); these keep what
// users are shown locked to what the scorer actually does.
console.log("\n■ rubric: one row per scored component, in the scorer's order");
{
  const keys = computeInboxHealth({}).components.map((c) => c.key);
  const rubricKeys = HEALTH_RUBRIC.map((r) => r.key);
  assert(JSON.stringify(rubricKeys) === JSON.stringify(keys), `rubric keys match components (${rubricKeys.join(",")})`);
  assert(HEALTH_RUBRIC.every((r) => r.rule.length > 20 && r.short.length > 0), "every row has a rule and a short name");
  assert(HEALTH_RUBRIC.find((r) => r.key === "blacklist")?.rule.includes(`−${PENALTY.blacklist}`) === true, "blacklist rule quotes PENALTY.blacklist");
  assert(HEALTH_RUBRIC.find((r) => r.key === "reply_signal")?.rule.includes(`−${PENALTY.replyDrop.bad}`) === true, "reply rule quotes PENALTY.replyDrop.bad");
  assert(HEALTH_SCALE.some((l) => l.includes("Healthy 80–100") && l.includes("Critical below 50")), "scale line matches the band cut-offs");
}

console.log("\n■ scoreMath: the score as arithmetic, equal to the stored score");
{
  const r = computeInboxHealth({
    dbl: { status: "clean", detail: "not listed" },
    domainAuth: { domain: "x.com", spf: ok(), dkim: ok(), dmarc: warn("p=none") },
    mx: ok(),
    engagement: eng([316, 1, 1], [120, 7, 5]),
  });
  const math = scoreMath(r.components);
  assert(math === `100 − ${PENALTY.dmarc.warn} DMARC − ${PENALTY.replyDrop.bad} reply rate = ${r.score}`, `math reads left to right (got "${math}")`);
  assert(r.score === 70, `and totals the stored score, 70 (got ${r.score})`);
  assert(scoreMath(computeInboxHealth({}).components) === "100 (nothing is costing points)", "clean mailbox → says nothing costs points");
}

// ---------- Summary ----------
console.log("\n" + "─".repeat(40));
if (fail === 0) {
  console.log(`✓ ${pass} assertions passed`);
  process.exit(0);
} else {
  console.error(`✗ ${fail} failed, ${pass} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
