#!/usr/bin/env node
/**
 * Unit tests for src/lib/millionverifier/policy.ts: the pure decision logic of
 * the pre-send verification gate. No network, no DB. Imports the REAL module by
 * relative path (tsx resolves the .ts extension); the module's `import type`
 * references to @/types/app and ./client are erased at load, so nothing else is
 * pulled in.
 *
 * Usage:
 *   npx tsx scripts/test-millionverifier-policy.ts
 */

import {
  decideFromCached,
  decideFromResult,
  isFresh,
  shouldAlertAccountError,
  shouldAlertLowCredits,
  VERIFICATION_TTL_DAYS,
  FIRST_EMAIL_TTL_DAYS,
  FOLLOW_UP_RULES,
  gateRulesFor,
  parkFromCachedStatus,
  unprovenHoldReason,
  UNPROVEN_HOLD_PREFIX,
  MAX_UNKNOWN_ATTEMPTS,
  MAX_ERROR_ATTEMPTS,
  type CacheView,
} from "../src/lib/millionverifier/policy.ts";
import type { MillionVerifierResponse } from "../src/lib/millionverifier/client.ts";

// ---------- Test harness ----------
let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

const NOW = new Date("2026-08-22T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const daysAgo = (n: number) => new Date(NOW_MS - n * DAY).toISOString();
const hoursAgo = (n: number) => new Date(NOW_MS - n * HOUR).toISOString();

function cache(
  status: CacheView["email_verification_status"],
  verifiedAt: string | null,
  attempts = 0,
): CacheView {
  return {
    email_verification_status: status,
    email_verified_at: verifiedAt,
    email_verification_attempts: attempts,
  };
}

function resp(partial: Partial<MillionVerifierResponse>): MillionVerifierResponse {
  return {
    email: "x@y.com",
    quality: "good",
    result: "ok",
    resultcode: 1,
    subresult: "",
    free: false,
    role: false,
    didyoumean: "",
    credits: 1000,
    executiontime: 1,
    error: "",
    livemode: true,
    ...partial,
  };
}

// ---------- isFresh ----------
console.log("\nisFresh:");
assert(isFresh(daysAgo(VERIFICATION_TTL_DAYS - 1), NOW) === true, "29d old is fresh");
assert(isFresh(daysAgo(VERIFICATION_TTL_DAYS + 1), NOW) === false, "31d old is stale");
assert(isFresh(null, NOW) === false, "null is not fresh");
assert(isFresh("not-a-date", NOW) === false, "garbage timestamp is not fresh");

// ---------- decideFromCached ----------
console.log("\ndecideFromCached:");
assert(decideFromCached(cache(null, null), NOW).action === "verify", "no status -> verify");
assert(
  decideFromCached(cache("ok", daysAgo(1)), NOW).action === "send",
  "fresh ok -> send",
);
{
  const d = decideFromCached(cache("catch_all", daysAgo(1)), NOW);
  assert(d.action === "send" && d.result === "catch_all" && d.risky === true, "fresh catch_all -> send risky");
}
{
  const d = decideFromCached(cache("invalid", daysAgo(1)), NOW);
  assert(d.action === "skip" && d.status === "invalid", "fresh invalid -> skip");
}
{
  const d = decideFromCached(cache("disposable", daysAgo(1)), NOW);
  assert(d.action === "skip" && d.status === "disposable", "fresh disposable -> skip");
}
assert(
  decideFromCached(cache("ok", daysAgo(VERIFICATION_TTL_DAYS + 1)), NOW).action === "verify",
  "stale ok -> verify",
);
{
  const d = decideFromCached(cache("unknown", hoursAgo(0.25), 0), NOW); // 15 min ago
  assert(d.action === "hold" && d.reason === "unknown_backoff", "fresh unknown within backoff -> hold");
}
assert(
  decideFromCached(cache("unknown", hoursAgo(2), 0), NOW).action === "verify",
  "fresh unknown past backoff -> verify",
);
{
  const d = decideFromCached(cache("unknown", hoursAgo(2), MAX_UNKNOWN_ATTEMPTS), NOW);
  assert(d.action === "send" && d.result === "unknown" && d.risky === true, "unknown at max attempts -> send risky");
}
{
  const d = decideFromCached(cache("error", hoursAgo(0.25), 1), NOW);
  assert(d.action === "hold" && d.reason === "error_backoff", "fresh error within backoff -> hold");
}
{
  const d = decideFromCached(cache("error", hoursAgo(2), MAX_ERROR_ATTEMPTS), NOW);
  assert(d.action === "skip" && d.status === "error", "error at max attempts -> skip");
}

// ---------- decideFromResult ----------
console.log("\ndecideFromResult:");
{
  const { decision, patch } = decideFromResult(resp({ result: "ok", quality: "good" }), 0, NOW);
  assert(decision.action === "send" && decision.result === "ok", "ok result -> send");
  assert(patch.email_verification_status === "ok" && patch.email_verification_attempts === 0, "ok patch: status ok, attempts reset");
  assert(patch.email_verified_at === NOW.toISOString(), "patch stamps verified_at = now");
}
{
  const { decision, patch } = decideFromResult(resp({ result: "catch_all", quality: "risky" }), 0, NOW);
  assert(decision.action === "send" && decision.result === "catch_all", "catch_all -> send");
  assert(patch.email_verification_quality === "risky", "catch_all patch: quality risky");
}
{
  const { decision } = decideFromResult(resp({ result: "invalid", quality: "bad" }), 0, NOW);
  assert(decision.action === "skip" && decision.status === "invalid", "invalid -> skip");
}
{
  const { decision, patch } = decideFromResult(resp({ result: "unknown", quality: "risky" }), 0, NOW);
  assert(decision.action === "hold" && decision.reason === "unknown_backoff", "unknown 1st -> hold");
  assert(patch.email_verification_attempts === 1, "unknown patch: attempts incremented to 1");
}
{
  const { decision, patch } = decideFromResult(resp({ result: "unknown" }), MAX_UNKNOWN_ATTEMPTS - 1, NOW);
  assert(decision.action === "send" && decision.result === "unknown", "unknown at last attempt -> send risky");
  assert(patch.email_verification_attempts === MAX_UNKNOWN_ATTEMPTS, "unknown patch: attempts hits max");
}
{
  const { decision } = decideFromResult(resp({ result: "error" }), MAX_ERROR_ATTEMPTS - 1, NOW);
  assert(decision.action === "skip" && decision.status === "error", "error at last attempt -> skip");
}
{
  // A definitive verdict after prior indeterminate attempts resets the counter.
  const { patch } = decideFromResult(resp({ result: "ok" }), 2, NOW);
  assert(patch.email_verification_attempts === 0, "ok after prior attempts resets counter to 0");
}
{
  // An unrecognized result is coerced to "error" (never treated as ok).
  const { decision, patch } = decideFromResult(resp({ result: "wat" }), 0, NOW);
  assert(patch.email_verification_status === "error", "unknown result string -> error status");
  assert(decision.action === "hold", "unknown result string -> hold (not send)");
}

// ---------- First emails: only proven addresses (owner picks 2026-11-01) ----------
// PolishPoint's first 200 first emails: catch-alls bounced 4 of 7. A first email
// to a catch-all / unknown address is parked unless the campaign opts in, and
// needs a check from the last 7 days. Follow-ups keep the old rules.
console.log("\nfirst emails (gateRulesFor):");
const FIRST = gateRulesFor(0, false);
const FIRST_OPTED_IN = gateRulesFor(0, true);
assert(FIRST.holdUnproven === true && FIRST.ttlDays === FIRST_EMAIL_TTL_DAYS, "step 0, not opted in -> hold unproven, 7-day check");
assert(FIRST_OPTED_IN.holdUnproven === false && FIRST_OPTED_IN.ttlDays === FIRST_EMAIL_TTL_DAYS, "step 0, opted in -> send unproven, still 7-day check");
assert(gateRulesFor(1, false) === FOLLOW_UP_RULES && gateRulesFor(2, true) === FOLLOW_UP_RULES, "follow-ups -> 30-day cache, never parked");
assert(FIRST_EMAIL_TTL_DAYS === 7 && VERIFICATION_TTL_DAYS === 30, "the two windows are 7 and 30 days");
{
  const d = decideFromCached(cache("catch_all", daysAgo(1)), NOW, FIRST);
  assert(d.action === "park" && d.result === "catch_all", "first email, cached catch_all -> park");
}
{
  const d = decideFromCached(cache("catch_all", daysAgo(1)), NOW, FIRST_OPTED_IN);
  assert(d.action === "send" && d.result === "catch_all" && d.risky, "first email, cached catch_all, opted in -> send risky");
}
{
  const d = decideFromCached(cache("catch_all", daysAgo(1)), NOW, gateRulesFor(1, false));
  assert(d.action === "send" && d.result === "catch_all", "follow-up to a catch_all that took email 1 -> send risky");
}
{
  const d = decideFromCached(cache("unknown", hoursAgo(2), MAX_UNKNOWN_ATTEMPTS), NOW, FIRST);
  assert(d.action === "park" && d.result === "unknown", "first email, unknown out of retries -> park (never sends)");
}
{
  const d = decideFromCached(cache("unknown", hoursAgo(0.25), 1), NOW, FIRST);
  assert(d.action === "hold", "first email, unknown with retries left -> hold for the retry, not park yet");
}
assert(decideFromCached(cache("ok", daysAgo(8)), NOW, FIRST).action === "verify", "first email, ok checked 8 days ago -> check again");
assert(decideFromCached(cache("ok", daysAgo(6)), NOW, FIRST).action === "send", "first email, ok checked 6 days ago -> send");
assert(decideFromCached(cache("ok", daysAgo(20)), NOW, gateRulesFor(1, false)).action === "send", "follow-up, ok checked 20 days ago -> send from cache");
assert(decideFromCached(cache("invalid", daysAgo(1)), NOW, FIRST).action === "skip", "first email, invalid -> still skipped");
{
  const { decision } = decideFromResult(resp({ result: "catch_all", quality: "risky" }), 0, NOW, FIRST);
  assert(decision.action === "park" && decision.result === "catch_all", "first email, live catch_all -> park (the Oct 29 greenway.com send)");
}
{
  const { decision } = decideFromResult(resp({ result: "unknown" }), MAX_UNKNOWN_ATTEMPTS - 1, NOW, FIRST);
  assert(decision.action === "park" && decision.result === "unknown", "first email, last unknown retry -> park");
}
{
  const { decision } = decideFromResult(resp({ result: "catch_all" }), 0, NOW, FIRST_OPTED_IN);
  assert(decision.action === "send" && decision.risky, "first email, live catch_all, opted in -> send risky");
}
{
  const { decision } = decideFromResult(resp({ result: "ok" }), 0, NOW, FIRST);
  assert(decision.action === "send" && decision.result === "ok", "first email, live ok -> send");
}
console.log("\nwith the check off (parkFromCachedStatus):");
assert(parkFromCachedStatus("catch_all", FIRST)?.action === "park", "gate off, cached catch_all, first email -> park");
assert(parkFromCachedStatus("unknown", FIRST)?.action === "park", "gate off, cached unknown, first email -> park");
assert(parkFromCachedStatus("ok", FIRST) === null, "gate off, cached ok -> no park");
assert(parkFromCachedStatus(null, FIRST) === null, "gate off, never checked -> no park (nothing on file)");
assert(parkFromCachedStatus("catch_all", FIRST_OPTED_IN) === null, "gate off, opted in -> no park");
assert(parkFromCachedStatus("catch_all", gateRulesFor(1, false)) === null, "gate off, follow-up -> no park");
assert(
  unprovenHoldReason("catch_all").startsWith(UNPROVEN_HOLD_PREFIX) && unprovenHoldReason("unknown").startsWith(UNPROVEN_HOLD_PREFIX),
  "the hold reason carries the prefix the release matches",
);

// ---------- shouldAlertLowCredits ----------
console.log("\nshouldAlertLowCredits:");
assert(shouldAlertLowCredits(null, 450) === true, "null prev, below threshold -> alert");
assert(shouldAlertLowCredits(600, 450) === true, "crossing 500 downward -> alert");
assert(shouldAlertLowCredits(450, 400) === false, "already below -> no alert");
assert(shouldAlertLowCredits(600, 600) === false, "above threshold -> no alert");
assert(shouldAlertLowCredits(400, 600) === false, "recovered above -> no alert");

// ---------- shouldAlertAccountError ----------
console.log("\nshouldAlertAccountError:");
assert(shouldAlertAccountError("auth", 1) === true, "definitive auth @1 -> alert");
assert(shouldAlertAccountError("auth", 2) === false, "definitive auth @2 -> silent");
assert(shouldAlertAccountError("credits", 1) === true, "definitive credits @1 -> alert");
assert(shouldAlertAccountError("blocked", 1) === true, "definitive blocked @1 -> alert");
assert(shouldAlertAccountError("transient", 1) === false, "transient @1 -> silent");
assert(shouldAlertAccountError("transient", 2) === false, "transient @2 -> silent");
assert(shouldAlertAccountError("transient", 3) === true, "transient @3 -> alert");
assert(shouldAlertAccountError("transient", 4) === false, "transient @4 -> silent (edge, not >=)");

// ---------- Summary ----------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
