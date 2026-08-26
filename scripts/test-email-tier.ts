#!/usr/bin/env node
/**
 * Unit tests for the shared email-tier classifier (list ordering + badges).
 * No network, no DB. Run: npx tsx scripts/test-email-tier.ts
 */
import {
  classifyEmailTier,
  emailTierRank,
  EMAIL_TIER_RANK,
  type EmailTierInput,
} from "../src/lib/enrichment/email-tier.ts";

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

const base: EmailTierInput = { email: null };

console.log("classifyEmailTier");
eq(classifyEmailTier(base), "none", "no email at all → none");
eq(classifyEmailTier({ ...base, company_email: "info@x.com" }), "company", "company_email reference only → company");
eq(classifyEmailTier({ ...base, email: "jane@x.com" }), "person", "plain email → person");
eq(
  classifyEmailTier({ ...base, email: "jane@x.com", email_provider_status: "ok" }),
  "person",
  "MV-ok pattern email → person",
);
eq(
  classifyEmailTier({ ...base, email: "jane@x.com", email_provider_status: "catch_all" }),
  "catch_all",
  "catch-all provenance → catch_all",
);
eq(
  classifyEmailTier({ ...base, email: "jane@x.com", email_verification_subresult: "catch_all" }),
  "catch_all",
  "send-time catch_all subresult → catch_all",
);
eq(
  classifyEmailTier({ ...base, email: "info@x.com", email_kind: "company_generic" }),
  "company",
  "backfilled generic inbox → company",
);
eq(
  classifyEmailTier({ ...base, email: "info@x.com", email_kind: "company_generic", email_provider_status: "catch_all" }),
  "company",
  "generic kind wins over catch_all provenance (matches the ledger)",
);
eq(
  classifyEmailTier({ ...base, email: "jane@x.com", company_email: "info@x.com" }),
  "person",
  "person email outranks a company reference on the same contact",
);

console.log("ordering ranks");
eq(EMAIL_TIER_RANK.person < EMAIL_TIER_RANK.company, true, "person sorts before company");
eq(EMAIL_TIER_RANK.company < EMAIL_TIER_RANK.catch_all, true, "company sorts before catch-all");
eq(EMAIL_TIER_RANK.catch_all < EMAIL_TIER_RANK.none, true, "catch-all sorts before none");
eq(emailTierRank({ email: "jane@x.com" }), 0, "rank helper: person = 0");
eq(emailTierRank(base), 3, "rank helper: none = 3");

// Found-first list ordering, end to end: person → company → catch-all → none,
// stable within a tier.
const rows: (EmailTierInput & { id: string })[] = [
  { id: "none-1", email: null },
  { id: "catch-1", email: "g@x.com", email_provider_status: "catch_all" },
  { id: "person-1", email: "a@x.com" },
  { id: "company-1", email: null, company_email: "info@x.com" },
  { id: "person-2", email: "b@x.com" },
];
const ordered = rows
  .map((r, i) => ({ r, i, rank: emailTierRank(r) }))
  .sort((a, b) => a.rank - b.rank || a.i - b.i)
  .map((x) => x.r.id);
eq(
  ordered.join(","),
  "person-1,person-2,company-1,catch-1,none-1",
  "list sorts person → company → catch-all → none, stable within tier",
);

console.log(`\nemail-tier: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
