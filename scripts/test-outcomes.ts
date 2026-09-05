#!/usr/bin/env node
/**
 * Unit tests for the delivered-outcome classifier + tier bucketing (the margin
 * ledger / radial data). No network, no DB. Run: npx tsx scripts/test-outcomes.ts
 */
import { classifyContactOutcome, bestTier, addOutcome, type OutcomeInput } from "../src/lib/enrichment/outcomes.ts";

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

const base: OutcomeInput = {
  email: null,
  emailVerificationStatus: null,
  emailKind: null,
  emailProviderStatus: null,
  companyEmail: null,
  companyPhone: null,
  phone: null,
  firstName: null,
};

console.log("classifyContactOutcome");
{
  const f = classifyContactOutcome(base);
  eq(f.record, true, "bare record still counts as a record");
  eq(bestTier(f), "tier_none", "nothing found → tier_none");
}
{
  const f = classifyContactOutcome({ ...base, companyPhone: "+15551234567" });
  eq(f.phone, true, "company phone counts as phone");
  eq(bestTier(f), "tier_phone", "phone only → tier_phone");
}
{
  const f = classifyContactOutcome({ ...base, companyEmail: "info@x.com", companyPhone: "+1555" });
  eq(f.company_email, true, "company inbox flag");
  eq(f.personal_email, false, "company inbox is not a personal email");
  eq(bestTier(f), "tier_company", "company email beats phone");
}
{
  // Backfilled generic on contacts.email: sendable, but counts as COMPANY tier.
  const f = classifyContactOutcome({ ...base, email: "info@x.com", emailKind: "company_generic" });
  eq(f.personal_email, false, "backfilled generic is not personal");
  eq(f.company_email, true, "backfilled generic counts as company email");
  eq(bestTier(f), "tier_company", "backfilled generic → tier_company");
}
{
  const f = classifyContactOutcome({ ...base, email: "jane@x.com", firstName: "Jane", companyPhone: "+1555" });
  eq(f.personal_email, true, "person email flag");
  eq(f.owner_name, true, "owner name flag");
  eq(f.verified_email, false, "unverified personal is not verified");
  eq(bestTier(f), "tier_personal", "personal email is the top tier");
}
{
  const f = classifyContactOutcome({ ...base, email: "jane@x.com", emailVerificationStatus: "ok" });
  eq(f.verified_email, true, "MV ok → verified");
}
{
  const f = classifyContactOutcome({ ...base, email: "info@x.com", emailKind: "company_generic", emailVerificationStatus: "ok" });
  eq(f.verified_email, false, "verified generic does NOT count as verified personal");
}
{
  // Catch-all pattern guess on contacts.email (accept_catch_all_guesses on):
  // its own flag + tier, never personal, never verified.
  const f = classifyContactOutcome({ ...base, email: "jane@x.com", emailProviderStatus: "catch_all", firstName: "Jane" });
  eq(f.catch_all_email, true, "catch-all guess flag");
  eq(f.personal_email, false, "catch-all guess is not a personal email");
  eq(f.verified_email, false, "catch-all guess is never verified");
  eq(bestTier(f), "tier_catch_all", "catch-all guess → tier_catch_all");
}
{
  // A catch-all guess alongside a scraped company inbox: company outranks it.
  const f = classifyContactOutcome({ ...base, email: "jane@x.com", emailProviderStatus: "catch_all", companyEmail: "info@x.com" });
  eq(bestTier(f), "tier_company", "company inbox outranks a catch-all guess");
}
{
  // Catch-all beats phone-only in the exclusive tiers.
  const f = classifyContactOutcome({ ...base, email: "jane@x.com", emailProviderStatus: "catch_all", phone: "+1555" });
  eq(bestTier(f), "tier_catch_all", "catch-all guess outranks phone-only");
}
{
  // A backfilled generic that ALSO carries catch_all provenance stays company,
  // the generic-inbox kind wins (it is a real scraped address, not a guess).
  const f = classifyContactOutcome({ ...base, email: "info@x.com", emailKind: "company_generic", emailProviderStatus: "catch_all" });
  eq(f.catch_all_email, false, "generic kind wins over catch_all provenance");
  eq(bestTier(f), "tier_company", "backfilled generic stays tier_company");
}

console.log("addOutcome accumulation");
{
  const counts: Record<string, number> = {};
  addOutcome(counts, classifyContactOutcome({ ...base, email: "a@x.com" }));
  addOutcome(counts, classifyContactOutcome({ ...base, companyEmail: "info@x.com" }));
  addOutcome(counts, classifyContactOutcome({ ...base, email: "b@x.com", emailProviderStatus: "catch_all" }));
  addOutcome(counts, classifyContactOutcome({ ...base, phone: "+1555" }));
  addOutcome(counts, classifyContactOutcome(base));
  eq(counts.record, 5, "5 records");
  eq(counts.tier_personal, 1, "1 personal tier");
  eq(counts.tier_company, 1, "1 company tier");
  eq(counts.tier_catch_all, 1, "1 catch-all tier");
  eq(counts.tier_phone, 1, "1 phone tier");
  eq(counts.tier_none, 1, "1 none tier");
  eq(
    (counts.tier_personal ?? 0) +
      (counts.tier_company ?? 0) +
      (counts.tier_catch_all ?? 0) +
      (counts.tier_phone ?? 0) +
      (counts.tier_none ?? 0),
    5,
    "tiers are exclusive and sum to the record count",
  );
}

console.log(`\noutcomes: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
