#!/usr/bin/env node
/**
 * Unit tests for src/lib/deliverability/inbox-health.ts — the pure per-mailbox
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
 *   - 0 replies on 100 sends/14d → 90  / healthy (warn -10)
 *   - any reply on 100 sends/14d → reply signal ok, no deduction
 *   - 2 of 3 seeds in spam       → 55  / watch   (bad -45; never critical alone)
 *   - 1 of 4 seeds in spam       → 75  / watch   (bad -25)
 *   - 1 of 3 seeds missing       → 90  / healthy (warn -10)
 *   - Promotions majority        → 95  / healthy (warn -5)
 *   - all seeds in inbox         → ok, detail names receiver auth
 *   - total DNS resolver outage  → exactly 50 / watch
 *   - empty inputs               → 100 / healthy, every component unchecked
 *
 * Usage:
 *   npx tsx scripts/test-inbox-health.ts
 */

import {
  computeInboxHealth,
  bandForScore,
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
  assert(r.components.length === 9, `all 9 components present (got ${r.components.length})`);
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

// ---------- 6. Total DNS outage ----------
console.log("\n■ total DNS resolver outage → exactly 50 / watch");
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
  assert(r.band === "healthy", `band is healthy — soft bounces never critical alone (got ${r.band})`);
}

console.log("\n■ soft bounce unchecked when softBounced7d omitted");
{
  const r = computeInboxHealth({ bounces: { sent7d: 100, bounced7d: 1 } });
  const soft = r.components.find((c) => c.key === "soft_bounce_rate");
  assert(soft?.status === "unchecked" && soft.deduction === 0, "soft bounce unchecked, no deduction");
}

// ---------- 7b. Reply signal ----------
console.log("\n■ 0 replies on 100 sends/14d → warn -10 → 90 / healthy");
{
  const r = computeInboxHealth({
    dbl: { status: "clean", detail: "not listed" },
    domainAuth: goodDns,
    mx: ok(),
    bounces: { sent7d: 100, bounced7d: 1 },
    replies: { sent14d: 100, replied14d: 0 },
  });
  const rep = r.components.find((c) => c.key === "reply_signal");
  assert(rep?.status === "warn" && rep.deduction === 10, "reply signal is warn, -10");
  assert(r.score === 90, `score is 90 (got ${r.score})`);
  assert(r.band === "healthy", `band is healthy (got ${r.band})`);
}

console.log("\n■ any reply on 100 sends/14d → reply signal ok, no deduction");
{
  const r = computeInboxHealth({ replies: { sent14d: 100, replied14d: 3 } });
  const rep = r.components.find((c) => c.key === "reply_signal");
  assert(rep?.status === "ok" && rep.deduction === 0, "reply signal ok, no deduction");
  assert(r.score === 100, `score is 100 (got ${r.score})`);
}

console.log("\n■ 39 sends/14d → reply signal unchecked (below floor)");
{
  const r = computeInboxHealth({ replies: { sent14d: 39, replied14d: 0 } });
  const rep = r.components.find((c) => c.key === "reply_signal");
  assert(rep?.status === "unchecked" && rep.deduction === 0, "reply signal unchecked below 40 sends");
  assert(r.score === 100, `score is 100 (got ${r.score})`);
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
  assert(r.band === "watch", `band is watch — a bad panel alone never goes critical (got ${r.band})`);
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
