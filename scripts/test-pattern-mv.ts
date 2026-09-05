#!/usr/bin/env node
/**
 * Unit tests for src/lib/enrichment/pattern-mv.ts: the pure email-candidate
 * generator. No network, no DB. Imports the REAL module by relative path (tsx
 * resolves the .ts extension); the module's `import type` reference to the MV
 * client is erased at load, so nothing else is pulled in.
 *
 * Usage:
 *   npx tsx scripts/test-pattern-mv.ts
 */

import { generateEmailCandidates } from "../src/lib/enrichment/pattern-mv.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    failures.push(`${msg}\n    expected ${e}\n    actual   ${a}`);
  }
}

// Canonical order: first.last → first → flast → f.last → last → firstlast
eq(
  generateEmailCandidates("Jane", "Doe", "acme.com"),
  ["jane.doe@acme.com", "jane@acme.com", "jdoe@acme.com", "j.doe@acme.com", "doe@acme.com", "janedoe@acme.com"],
  "full name, clean domain → all six patterns in order",
);

// Diacritics stripped, casing normalized.
eq(
  generateEmailCandidates("José", "O'Brien", "Acme.com"),
  ["jose.obrien@acme.com", "jose@acme.com", "jobrien@acme.com", "j.obrien@acme.com", "obrien@acme.com", "joseobrien@acme.com"],
  "diacritics + apostrophe + uppercase normalized",
);

// Domain normalization: strips scheme, www, and any path.
eq(
  generateEmailCandidates("Jane", "Doe", "https://www.acme.com/contact"),
  ["jane.doe@acme.com", "jane@acme.com", "jdoe@acme.com", "j.doe@acme.com", "doe@acme.com", "janedoe@acme.com"],
  "url-shaped domain normalized to bare host",
);

// First name only → the last-dependent patterns collapse away, deduped.
eq(
  generateEmailCandidates("Jane", "", "acme.com"),
  ["jane@acme.com"],
  "first name only → single candidate",
);

// Last name only.
eq(
  generateEmailCandidates(null, "Doe", "acme.com"),
  ["doe@acme.com"],
  "last name only → single candidate",
);

// No usable name → empty.
eq(generateEmailCandidates("", "", "acme.com"), [], "no name → no candidates");
// No domain → empty.
eq(generateEmailCandidates("Jane", "Doe", ""), [], "no domain → no candidates");
eq(generateEmailCandidates("Jane", "Doe", null), [], "null domain → no candidates");

// Single-letter first: flast (jdoe) === firstlast (jdoe), and f.last (j.doe) ===
// first.last (j.doe): the duplicates dedupe out, preserving first occurrence.
eq(
  generateEmailCandidates("J", "Doe", "acme.com"),
  ["j.doe@acme.com", "j@acme.com", "jdoe@acme.com", "doe@acme.com"],
  "single-letter first: duplicate patterns dedupe",
);

console.log(`\npattern-mv candidate generator: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFailures:\n" + failures.map((f) => "  ✗ " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
