#!/usr/bin/env node
/**
 * Unit tests for the bundled US states module — the abbr↔full-name↔FIPS lookups
 * the maps-search route uses to force every area's state to the full NAME the
 * compass actor requires. No network, no DB. Run: npx tsx scripts/test-us-states.ts
 */
import {
  US_STATES,
  stateNameFromAbbr,
  stateAbbrFromName,
  stateNameFromFips,
  normalizeStateName,
} from "../src/lib/geo/us-states.ts";

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
function ok(cond: boolean, msg: string) {
  eq(Boolean(cond), true, msg);
}

console.log("US_STATES — completeness");
eq(US_STATES.length, 51, "50 states + DC = 51 rows");
ok(US_STATES.every((s) => /^[A-Z]{2}$/.test(s.code)), "every code is a 2-letter uppercase abbr");
ok(US_STATES.every((s) => /^\d{2}$/.test(s.fips)), "every FIPS is 2 digits");
eq(new Set(US_STATES.map((s) => s.code)).size, 51, "codes are unique");
eq(new Set(US_STATES.map((s) => s.fips)).size, 51, "FIPS are unique");
eq(new Set(US_STATES.map((s) => s.name)).size, 51, "names are unique");
ok(US_STATES.some((s) => s.code === "DC" && s.name === "District of Columbia"), "DC is present");

console.log("stateNameFromAbbr");
eq(stateNameFromAbbr("TX"), "Texas", "TX → Texas");
eq(stateNameFromAbbr("tx"), "Texas", "tx (lowercase) → Texas");
eq(stateNameFromAbbr(" ca "), "California", "trims/uppercases");
eq(stateNameFromAbbr("XX"), null, "unknown abbr → null");

console.log("stateAbbrFromName");
eq(stateAbbrFromName("Texas"), "TX", "Texas → TX");
eq(stateAbbrFromName("texas"), "TX", "case-insensitive");
eq(stateAbbrFromName("New York"), "NY", "New York → NY");
eq(stateAbbrFromName("Nowhere"), null, "unknown name → null");

console.log("stateNameFromFips");
eq(stateNameFromFips("48"), "Texas", "48 → Texas");
eq(stateNameFromFips("06"), "California", "06 → California");
eq(stateNameFromFips("99"), null, "unknown FIPS → null");

console.log("normalizeStateName — the route's abbr/name → full name");
eq(normalizeStateName("TX"), "Texas", "abbr TX → Texas");
eq(normalizeStateName("texas"), "Texas", "lowercase name → Texas");
eq(normalizeStateName("Texas"), "Texas", "full name passes through");
eq(normalizeStateName("CA"), "California", "abbr CA → California");
eq(normalizeStateName("  New York  "), "New York", "trims");
eq(normalizeStateName("Zz"), null, "garbage → null");
eq(normalizeStateName(""), null, "empty → null");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
