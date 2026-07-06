#!/usr/bin/env node
/**
 * Unit tests for src/lib/native/tokens.ts — the shared {{merge_tag}} token
 * helpers used by BOTH the native sender and the builder preview.
 *
 * Covers:
 *   1. normalizeVarKey collapses casing/spacing/underscores to one key.
 *   2. buildTokenMap fills the standard fields from a contact and folds
 *      custom_fields via normalizeVarKey (skips null, String()s non-strings).
 *   3. applyTokens fills known tokens, LEAVES unknown tokens untouched with no
 *      fallback (the exact send behavior), and uses the fallback when provided.
 *   4. SAMPLE_TOKENS + sampleFallback produce a fully-filled string with no
 *      leftover {{...}}.
 *
 * No network. No DB. Imports the REAL production module by relative path — tsx
 * resolves the .ts extension.
 *
 * Usage:
 *   npx tsx scripts/test-tokens.ts
 */

import {
  normalizeVarKey,
  buildTokenMap,
  applyTokens,
  SAMPLE_TOKENS,
  sampleFallback,
  type TokenContact,
} from "../src/lib/native/tokens.ts";

// ---------- Test harness ----------
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

// ---------- 1. normalizeVarKey ----------
console.log("\n■ normalizeVarKey collapses casing/spacing/underscores");
{
  assert(normalizeVarKey("First Name") === "firstname", '"First Name" -> "firstname"');
  assert(normalizeVarKey("first_name") === "firstname", '"first_name" -> "firstname"');
  assert(normalizeVarKey("FirstName") === "firstname", '"FirstName" -> "firstname"');
  assert(normalizeVarKey("  FIRST-name  ") === "firstname", '"  FIRST-name  " -> "firstname"');
  assert(normalizeVarKey("Property Address") === "propertyaddress", '"Property Address" -> "propertyaddress"');
  assert(normalizeVarKey("") === "", "empty string stays empty");
}

// ---------- 2. buildTokenMap ----------
console.log("\n■ buildTokenMap fills standard fields + folds custom_fields");
{
  const contact: TokenContact = {
    first_name: "Jane",
    last_name: "Doe",
    company_name: "Doe Plumbing",
    title: "Owner",
    intro_line: "loved the site redesign",
    email: "jane@doeplumbing.com",
    phone: "555-1212",
    custom_fields: { PropertyAddress: "123 Oak", SoldDate: "March 3rd", visits: 7, empty: null },
  };
  const map = buildTokenMap(contact, "Alex Rivera");

  assert(map.firstname === "Jane", "firstname from contact");
  assert(map.lastname === "Doe", "lastname from contact");
  assert(map.fullname === "Jane Doe", "fullname joins first + last");
  assert(map.company === "Doe Plumbing" && map.companyname === "Doe Plumbing", "company/companyname both set");
  assert(map.title === "Owner", "title from contact");
  assert(map.introline === "loved the site redesign" && map.intro === "loved the site redesign", "introline/intro both set");
  assert(map.email === "jane@doeplumbing.com", "email from contact");
  assert(map.phone === "555-1212", "phone from contact");
  assert(map.yourname === "Alex Rivera" && map.sendername === "Alex Rivera" && map.myname === "Alex Rivera", "yourname/sendername/myname = senderName");

  // custom_fields folded via normalizeVarKey.
  assert(map.propertyaddress === "123 Oak", 'custom PropertyAddress -> key "propertyaddress"');
  assert(map.solddate === "March 3rd", 'custom SoldDate -> key "solddate"');
  // non-string coerced via String().
  assert(map.visits === "7", "non-string custom value String()-coerced");
  // null custom value skipped.
  assert(!("empty" in map), "null custom value is skipped");

  // Missing standard columns fall back to "".
  const sparse: TokenContact = {
    first_name: null,
    last_name: null,
    company_name: null,
    title: null,
    intro_line: null,
    email: null,
    phone: null,
    custom_fields: null,
  };
  const sparseMap = buildTokenMap(sparse, "Bot");
  assert(sparseMap.firstname === "" && sparseMap.company === "", "null standard columns become empty strings");
  assert(sparseMap.fullname === "", "fullname of a nameless contact is empty");
  assert(sparseMap.yourname === "Bot", "senderName still applied with null custom_fields");
}

// ---------- 3. applyTokens ----------
console.log("\n■ applyTokens fills known, leaves unknown, honors fallback");
{
  const map = buildTokenMap(
    {
      first_name: "Jane",
      last_name: "Doe",
      company_name: "Doe Plumbing",
      title: null,
      intro_line: null,
      email: null,
      phone: null,
      custom_fields: { PropertyAddress: "123 Oak" },
    },
    "Alex Rivera",
  );

  // Known standard + custom tokens, casing/spacing insensitive.
  assert(
    applyTokens("Hi {{First Name}} at {{company_name}}", map) === "Hi Jane at Doe Plumbing",
    "known standard tokens filled (case/space insensitive)",
  );
  assert(
    applyTokens("re: {{PropertyAddress}}", map) === "re: 123 Oak",
    "known custom token filled",
  );
  assert(applyTokens("from {{YourName}}", map) === "from Alex Rivera", "sender identity token filled");

  // Unknown token with NO fallback: left untouched (exact send behavior).
  assert(
    applyTokens("call {{unknownToken}} now", map) === "call {{unknownToken}} now",
    "unknown token left untouched with no fallback",
  );
  assert(
    applyTokens("{{first_name}} + {{mystery}}", map) === "Jane + {{mystery}}",
    "known filled, unknown left in place, side by side",
  );

  // Fallback used only for unknown tokens.
  const fb = (raw: string) => `[${raw}]`;
  assert(
    applyTokens("{{first_name}} {{mystery}}", map, fb) === "Jane [mystery]",
    "fallback applied to unknown, not to known",
  );
  // A fallback returning null still leaves the token untouched.
  const nullFb = () => null;
  assert(
    applyTokens("{{mystery}}", map, nullFb) === "{{mystery}}",
    "fallback returning null leaves token untouched",
  );

  // Does NOT trim (caller's job).
  assert(applyTokens("  {{first_name}}  ", map) === "  Jane  ", "applyTokens does not trim");
}

// ---------- 4. SAMPLE mode: fully filled, no leftovers ----------
console.log("\n■ SAMPLE_TOKENS + sampleFallback leave no {{...}} behind");
{
  const template =
    "Hi {{first_name}}, {{intro_line}}. As {{title}} at {{company}}, " +
    "does {{PropertyAddress}} still need work? Sold {{SoldDate}} in {{city}}. " +
    "Reach {{listingAgent}} re: {{policy_number}}. — {{YourName}} ({{email}})";

  const out = applyTokens(template, SAMPLE_TOKENS, sampleFallback);

  assert(!/\{\{.*?\}\}/.test(out), `no leftover {{...}} in SAMPLE render ("${out}")`);
  assert(out.includes("Sarah"), "standard sample value present");
  assert(out.includes("123 Oak Street"), "curated custom sample (PropertyAddress) present");
  assert(out.includes("March 3rd"), "curated custom sample (SoldDate) present");
  assert(out.includes("Austin"), "curated custom sample (city) present");

  // Humanized fallback for tokens with no curated value.
  assert(sampleFallback("listingAgent") === "Listing Agent", "camelCase humanized -> Title Case");
  assert(sampleFallback("policy_number") === "Policy Number", "underscore humanized -> Title Case");
  assert(sampleFallback("PropertyAddress") === "123 Oak Street", "curated custom overrides humanize");
  assert(out.includes("Listing Agent") && out.includes("Policy Number"), "humanized fallbacks land in the render");
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
