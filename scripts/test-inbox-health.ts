#!/usr/bin/env node
/**
 * Unit tests for src/lib/deliverability/inbox-health.ts — the pure per-mailbox
 * health scorer. No network, no DB; imports the REAL production module by
 * relative path (type-only cross-imports are erased at runtime).
 *
 * Anchors (see the weights table in inbox-health.ts):
 *   - perfect signals            → 100 / healthy
 *   - DBL-listed alone           → 40  / critical
 *   - >10% bounce alone          → 40  / critical
 *   - 3% bounce on 100 sends     → 85  / healthy
 *   - 19 sends                   → bounce unchecked, no deduction
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
  assert(r.components.length === 6, `all 6 components present (got ${r.components.length})`);
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
