// Unit tests for the pure Findymail response parser. Run: npx tsx scripts/test-findymail.ts
//
// The client itself is I/O (one fetch, typed errors) and is exercised live via a
// probe / the settings Test-connection button, not here. What we CAN pin purely
// is parseFindResponse: it must extract the email out of the nested `contact`
// object on a hit, and report found:false (credit_charged:false) on every miss
// shape, since Findymail bills only on a hit.

import { parseFindResponse } from "../src/lib/findymail/client.ts";

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

console.log("■ parseFindResponse, hit");
{
  const r = parseFindResponse({ contact: { name: "Elon Musk", email: "elon@tesla.com", domain: "tesla.com" } });
  assert(r.found === true, "a contact with an email is found");
  assert(r.email === "elon@tesla.com", "the email is extracted");
  assert(r.name === "Elon Musk", "the name is extracted");
  assert(r.credit_charged === true, "a hit charges a credit");
}

console.log("■ parseFindResponse, trims + tolerates whitespace");
{
  const r = parseFindResponse({ contact: { name: "  Jane Doe  ", email: "  jane@acme.com  " } });
  assert(r.email === "jane@acme.com", "email is trimmed");
  assert(r.name === "Jane Doe", "name is trimmed");
}

console.log("■ parseFindResponse, misses never charge");
{
  assert(parseFindResponse({ contact: null }).found === false, "null contact = miss");
  assert(parseFindResponse({ contact: null }).credit_charged === false, "null contact = no charge");
  assert(parseFindResponse({}).found === false, "absent contact = miss");
  assert(parseFindResponse({ contact: {} }).found === false, "contact with no email = miss");
  assert(parseFindResponse({ contact: { email: "" } }).found === false, "empty email = miss");
  assert(parseFindResponse({ contact: { email: "   " } }).found === false, "whitespace email = miss");
  assert(parseFindResponse({ contact: { email: 42 } }).found === false, "non-string email = miss");
  assert(parseFindResponse({ contact: "nope" as unknown as Record<string, unknown> }).found === false, "non-object contact = miss");
}

console.log("■ parseFindResponse, name-only miss preserves the name");
{
  const r = parseFindResponse({ contact: { name: "No Email Person" } });
  assert(r.found === false, "no email = miss");
  assert(r.name === "No Email Person", "the name still comes back on a miss");
  assert(r.credit_charged === false, "no email = no charge");
}

console.log(`\n${"─".repeat(40)}`);
if (failed === 0) {
  console.log(`✓ ${passed} assertions passed`);
} else {
  console.error(`✗ ${failed} failed, ${passed} passed`);
  process.exit(1);
}
