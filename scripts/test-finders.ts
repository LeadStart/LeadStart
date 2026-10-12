// Unit tests for the pure response parsers of the three email finders under
// test, plus the finder-test harness's sampler. Run: npx tsx scripts/test-finders.ts
//
// The clients are I/O (one fetch per call, typed errors) and are exercised
// live by the harness and the settings Test-connection buttons, not here. What
// we CAN pin purely is each parser: it must turn the provider's documented
// response shapes into the one normalised FinderResult, and report credits
// only where the provider says a credit was charged, since every one of them
// bills on a hit. Fixtures are the shapes quoted in each client's header
// comment from the vendor docs read on 2026-10-12.

import { parseEnrowResult } from "../src/lib/finders/enrow.ts";
import { parseIcypeasItem } from "../src/lib/finders/icypeas.ts";
import { parseDatagmaResult } from "../src/lib/finders/datagma.ts";
import { bareDomain } from "../src/lib/finders/types.ts";
import { stratifiedSample } from "./finder-test-sample.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log("■ Enrow: GET result, found");
{
  const r = parseEnrowResult(
    { email: "michael.scott@dundermifflin.com", qualification: "valid", credits_used: 1, info: { fullname: "Michael Scott" } },
    "srch_1",
  );
  assert(r.status === "found", "qualification valid + email = found");
  assert(r.email === "michael.scott@dundermifflin.com", "email extracted");
  assert(r.credits_reported === 1, "credits_used carried through");
  assert(r.search_id === "srch_1", "search id kept for re-reads");
  assert(r.provider === "enrow", "provider stamped");
}
console.log("■ Enrow: miss and still-running");
{
  const miss = parseEnrowResult({ qualification: "invalid", credits_used: 0 }, "s");
  assert(miss.status === "not_found" && miss.email === null, "qualification invalid = not_found, no email");
  assert(miss.credits_reported === 0, "a name+domain miss reports 0 credits");
  const li = parseEnrowResult({ qualification: "invalid", credits_used: 0.25, linkedin_status: "email_not_found" }, "s");
  assert(li.status === "not_found" && li.credits_reported === 0.25, "a LinkedIn-URL miss reports the 0.25 credit");
  assert(li.provider_status === "invalid/email_not_found", "the LinkedIn status is kept in the label");
  const run = parseEnrowResult({ qualification: "ongoing" }, "s");
  assert(run.status === "pending", "qualification ongoing = pending");
  const weird = parseEnrowResult({ qualification: "valid" }, "s");
  assert(weird.status === "not_found", "valid with no email is treated as a miss, never a hit");
}

console.log("■ Icypeas: read item, found");
{
  const r = parseIcypeasItem(
    {
      status: "DEBITED",
      results: { emails: [{ email: "pierre.landoin@icypeas.com", certainty: "ultra_sure", mxRecords: ["google.com"], mxProvider: "google" }] },
      _id: "p_1",
    },
    "p_1",
  );
  assert(r.status === "found", "DEBITED with an email = found");
  assert(r.email === "pierre.landoin@icypeas.com", "first email extracted");
  assert(r.provider_status === "DEBITED/ultra_sure", "status and certainty kept");
  assert(r.credits_reported === 1, "a found email costs 1 credit");
}
console.log("■ Icypeas: running, not found, debited-not-found");
{
  for (const s of ["NONE", "SCHEDULED", "IN_PROGRESS"]) {
    assert(parseIcypeasItem({ status: s }, "x").status === "pending", `${s} = pending`);
  }
  const nf = parseIcypeasItem({ status: "NOT_FOUND", results: { emails: [] } }, "x");
  assert(nf.status === "not_found" && nf.credits_reported === 0, "NOT_FOUND = not_found, 0 credits");
  const dnf = parseIcypeasItem({ status: "DEBITED_NOT_FOUND" }, "x");
  assert(dnf.status === "not_found" && dnf.credits_reported === 1, "DEBITED_NOT_FOUND = not_found but 1 credit (the docs say it is charged)");
  const bad = parseIcypeasItem({ status: "BAD_INPUT" }, "x");
  assert(bad.status === "not_found" && bad.provider_status === "BAD_INPUT", "BAD_INPUT = not_found with the raw status");
  const lower = parseIcypeasItem({ status: "debited", results: { emails: [{ email: "a@b.co" }] } }, "x");
  assert(lower.status === "found", "status is matched case-insensitively");
}

console.log("■ Datagma: verified, catch-all, miss");
{
  const ok = parseDatagmaResult({ email: "emilio@algolia.com", emailDomain: "algolia.com", status: "VALID", patterns: ["{first}"], mxfound: true, smtpCheck: true, cachAll: false });
  assert(ok.status === "found" && ok.email === "emilio@algolia.com", "smtp-checked, not catch-all = found");
  assert(ok.credits_reported === 1, "a verified email costs 1 credit");
  const ca = parseDatagmaResult({ email: "j.doe@firm.com", status: "Most Probable", mxfound: true, smtpCheck: false, cachAll: true });
  assert(ca.status === "catch_all" && ca.email === "j.doe@firm.com", "cachAll true = catch_all, address kept");
  assert(ca.credits_reported === 0, "a catch-all is not billed (Datagma: 'CatchALL emails are free')");
  const probable = parseDatagmaResult({ email: "x@y.com", status: "most probable", cachAll: false });
  assert(probable.status === "catch_all", "a 'Most Probable' status is catch_all even without the flag");
  const miss = parseDatagmaResult({ email: "", status: "NOT_FOUND", patterns: [] });
  assert(miss.status === "not_found" && miss.email === null, "no email = not_found");
  const spelled = parseDatagmaResult({ email: "x@y.com", catchAll: true });
  assert(spelled.status === "catch_all", "the correctly spelled catchAll flag is honoured too");
}

console.log("■ bareDomain");
{
  assert(bareDomain("https://www.Acme-Clean.com/about") === "acme-clean.com", "scheme, www and path stripped, lower-cased");
  assert(bareDomain(null) === "", "null = empty");
}

console.log("■ stratifiedSample: seeded, stratified, deterministic");
{
  type Row = { id: string; known: boolean };
  const pool: Row[] = [];
  for (let i = 0; i < 500; i++) pool.push({ id: `k${i}`, known: true });
  for (let i = 0; i < 2000; i++) pool.push({ id: `m${i}`, known: false });
  const a = stratifiedSample(pool, (r) => r.known, { known: 46, misses: 154 }, 20261013);
  const b = stratifiedSample(pool, (r) => r.known, { known: 46, misses: 154 }, 20261013);
  assert(a.length === 200, "200 rows drawn");
  assert(a.filter((r) => r.known).length === 46, "46 known-email rows");
  assert(a.filter((r) => !r.known).length === 154, "154 miss rows");
  assert(new Set(a.map((r) => r.id)).size === 200, "no duplicates");
  assert(JSON.stringify(a.map((r) => r.id)) === JSON.stringify(b.map((r) => r.id)), "the same seed draws the same sample");
  const c = stratifiedSample(pool, (r) => r.known, { known: 46, misses: 154 }, 1);
  assert(JSON.stringify(a.map((r) => r.id)) !== JSON.stringify(c.map((r) => r.id)), "a different seed draws a different sample");
  const small = stratifiedSample(pool.slice(0, 10), (r) => r.known, { known: 46, misses: 154 }, 5);
  assert(small.length === 10 && small.every((r) => r.known), "a short stratum is capped at what exists");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
