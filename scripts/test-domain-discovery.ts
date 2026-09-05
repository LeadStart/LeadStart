#!/usr/bin/env node
/**
 * Unit tests for src/lib/enrichment/domain-discovery.ts: the pure name→domain
 * validation logic. No network, no DB. Imports the REAL module by relative path
 * (tsx resolves the .ts extension); its only value dependency is the pure
 * apify/domain helpers.
 *
 * Usage:
 *   npx tsx scripts/test-domain-discovery.ts
 */

import {
  nameTokenMatch,
  preValidateCandidate,
  confirmViaHomepage,
  parseDomainLookupAnswer,
  extractContactLocation,
  buildDomainDiscoveryPrompt,
  type DomainLookupAnswer,
} from "../src/lib/enrichment/domain-discovery.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    failures.push(`${msg}\n    expected ${e}\n    actual   ${a}`);
  }
}
function ok(cond: boolean, msg: string): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
  }
}

// ---- nameTokenMatch ----
ok(nameTokenMatch("Morris Janitorial Services LLC", "morrisjanitorial.com"), "distinctive token in label");
ok(nameTokenMatch("Emerald City Cleaning", "emeraldcity.com"), "distinctive token (emerald) in label");
ok(nameTokenMatch("THP Janitorial Services", "thpservices.com"), "short distinctive token (thp, len 3) matches");
ok(nameTokenMatch("American Building Services", "abs.com"), "acronym of 3 all-generic tokens matches label");
ok(nameTokenMatch("Coleman Family", "colemanfamily.com"), "full concatenation equals label");
ok(!nameTokenMatch("ABC Janitorial Services", "janitorialservices.com"), "GENERIC-TOKEN TRAP: janitorialservices.com must NOT match ABC Janitorial Services");
ok(!nameTokenMatch("Morris Janitorial Services", "cleanpro.com"), "unrelated domain does not match");
ok(!nameTokenMatch("Summit Building Maintenance", "peakfacilities.com"), "no shared token → no match");

// ---- preValidateCandidate ----
const cite = (d: string): DomainLookupAnswer => ({ domain: d, confidence: "high", source_url: `https://${d}/about`, evidence: "x" });
eq(
  preValidateCandidate("Morris Janitorial Services", cite("morrisjanitorial.com"), []).kind,
  "accept",
  "name match + source_url on same domain → accept",
);
eq(
  preValidateCandidate("Morris Janitorial Services", { domain: "morrisjanitorial.com", confidence: "high", source_url: null, evidence: "x" }, []).kind,
  "needs_homepage",
  "name match but no citation → needs_homepage",
);
eq(
  preValidateCandidate("Summit Building Maintenance", { domain: "peakfacilities.com", confidence: "high", source_url: "https://peakfacilities.com", evidence: "x" }, []).kind,
  "needs_homepage",
  "citation-confirmed but name mismatch → needs_homepage",
);
eq(
  preValidateCandidate("Acme Cleaning", cite("yellowpages.com"), []).kind,
  "reject",
  "directory host → reject",
);
eq(
  preValidateCandidate("Acme Cleaning", cite("linkedin.com"), []).kind,
  "reject",
  "socials (via shared REJECTED_HOSTS → normalizeDomain null) → reject",
);
eq(
  preValidateCandidate("Acme Cleaning", { domain: null, confidence: null, source_url: null, evidence: "not found" }, []).kind,
  "reject",
  "null domain → reject (runner treats as clean not_found upstream)",
);
// citation via the citations[] array (not source_url)
eq(
  preValidateCandidate("Morris Janitorial Services", { domain: "morrisjanitorial.com", confidence: "high", source_url: "https://example.com/x", evidence: "x" }, ["https://morrisjanitorial.com/contact"]).kind,
  "accept",
  "name match + citations[] entry on domain → accept",
);

// ---- confirmViaHomepage ----
eq(confirmViaHomepage("Morris Janitorial Services", "x.com", "Welcome to Morris Janitorial, family-owned since 1998").kind, "accept", "homepage mentions distinctive token → accept");
eq(confirmViaHomepage("Morris Janitorial Services", "x.com", "Bob's Plumbing and Heating, call today").kind, "reject", "homepage lacks the name → reject");
eq(confirmViaHomepage("Morris Janitorial Services", "x.com", "").kind, "reject", "empty homepage text → reject (unreachable)");

// ---- parseDomainLookupAnswer ----
eq(
  parseDomainLookupAnswer('{"domain":"acme.com","confidence":"high","source_url":"https://acme.com","evidence":"found"}'),
  { domain: "acme.com", confidence: "high", source_url: "https://acme.com", evidence: "found" },
  "clean JSON parses",
);
eq(
  parseDomainLookupAnswer('```json\n{"domain":"acme.com","confidence":"medium","source_url":null,"evidence":"x"}\n```')?.domain,
  "acme.com",
  "markdown-fenced JSON still parses",
);
eq(parseDomainLookupAnswer("Sorry, I could not find a website.")?.domain ?? "NULL", "NULL", "prose without JSON → null");
eq(
  parseDomainLookupAnswer('{"domain":null,"confidence":null,"source_url":null,"evidence":"not found"}'),
  { domain: null, confidence: null, source_url: null, evidence: "not found" },
  "explicit null domain parses to null",
);

// ---- extractContactLocation ----
eq(extractContactLocation({ source_row: { location: "Seattle, Washington, United States" } }), "Seattle, Washington, United States", "LinkedIn source_row.location");
eq(extractContactLocation({ city: "Austin", state: "TX" }), "Austin, TX", "Scrap.io city/state");
eq(extractContactLocation({ enrichment: { profile: { location: "Denver, CO" } } }), "Denver, CO", "profiles-phase profile.location fallback");
eq(extractContactLocation(null), null, "null → null");
eq(extractContactLocation("nope"), null, "non-object → null");
eq(extractContactLocation({}), null, "empty object → null");

// ---- buildDomainDiscoveryPrompt ----
ok(!buildDomainDiscoveryPrompt("Acme Cleaning", null).includes("Location:"), "no location → no Location line");
ok(buildDomainDiscoveryPrompt("Acme Cleaning", "Seattle, WA").includes("Location: Seattle, WA"), "location present → Location line included");

console.log(`\ndomain-discovery: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFailures:\n" + failures.map((f) => "  ✗ " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
