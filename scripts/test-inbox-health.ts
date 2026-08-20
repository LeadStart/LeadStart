#!/usr/bin/env node
/**
 * Unit tests for src/lib/deliverability/inbox-health.ts — the pure per-mailbox
 * health scorer. No network, no DB; imports the REAL production module by
 * relative path (type-only cross-imports are erased at runtime).
 *
 * Anchors (see the weights table in inbox-health.ts):
 *   - perfect signals            → 100 / healthy  (8 components)
 *   - DBL-listed alone           → 40  / critical
 *   - >10% bounce alone          → 40  / critical
 *   - 3% bounce on 100 sends     → 85  / healthy
 *   - 19 sends                   → bounce unchecked, no deduction
 *   - 30% soft bounce on 100     → 85  / healthy (warn -15, never critical)
 *   - 0 replies on 100 sends/14d → 90  / healthy (warn -10)
 *   - any reply on 100 sends/14d → reply signal ok, no deduction
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
  assert(r.components.length === 8, `all 8 components present (got ${r.components.length})`);
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
