#!/usr/bin/env node
/**
 * Unit tests for the campaign variable registry + fail-safe token engine
 * (Instantly-style contact-list ↔ campaign alignment, migration 00092).
 * No network, no DB. Run: npx tsx scripts/test-campaign-variables.ts
 *
 * Covers:
 *   - applyTokens: inline {{token|default}} fallback + the NEVER-LEAK invariant
 *     (a live send blanks an unresolved token instead of emitting raw braces).
 *   - extractCampaignTokens: strips |default from the key, flags hasFallback
 *     (AND across occurrences), catches A/B-variant + branch tokens.
 *   - reconcileCampaignVariables: registry customs come from mapped columns ONLY (registry ∪ copy STANDARD ∪ mapped); a copy-only custom token never registers.
 *   - buildInitialMappingForTargets: an unmatched column becomes a NEW custom var.
 *   - allEmailTemplates: every variant + both branches feed extraction.
 */
import {
  applyTokens,
  extractCampaignTokens,
  reconcileCampaignVariables,
  splitToken,
  type CampaignVariable,
} from "../src/lib/native/tokens.ts";
import { buildInitialMappingForTargets, CUSTOM_TARGET_PREFIX } from "../src/lib/csv/parse-contacts.ts";
import { allEmailTemplates, type FlowGraph } from "../src/lib/flow/graph.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  if (g === w) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

// The sender's fallback fn: unresolved → "" (never leak braces to a recipient).
const blank = () => "";

console.log("\nsplitToken");
eq(splitToken("first_name"), { name: "first_name", fallback: null }, "no pipe → fallback null");
eq(splitToken("first_name|there"), { name: "first_name", fallback: "there" }, "splits on pipe");
eq(splitToken(" first_name | there "), { name: "first_name", fallback: "there" }, "trims both sides");
eq(splitToken("x|"), { name: "x", fallback: "" }, "explicit empty fallback preserved");
eq(splitToken("a|b|c"), { name: "a", fallback: "b|c" }, "splits on FIRST pipe only");

console.log("\napplyTokens — resolution");
eq(applyTokens("Hi {{first_name}}", { firstname: "Ann" }), "Hi Ann", "resolves a standard token");
eq(
  applyTokens("{{first_name}} at {{company}}", { firstname: "Ann", company: "Acme" }),
  "Ann at Acme",
  "resolves multiple tokens",
);
eq(applyTokens("Hi {{first_name|there}}", { firstname: "Ann" }), "Hi Ann", "value beats inline default");
eq(applyTokens("Hi {{first_name|there}}", {}), "Hi there", "inline default fills a missing token");
eq(
  applyTokens("{{company|their company}}", { company: "" }),
  "their company",
  "present-but-EMPTY value falls through to inline default",
);
eq(applyTokens("{{ first_name | there }}", {}), "there", "whitespace around the pipe is trimmed");

console.log("\napplyTokens — NEVER-LEAK invariant (sender fallback = '')");
eq(applyTokens("Hi {{first_name}}", {}, blank), "Hi ", "unknown standard token → blank, not braces");
eq(applyTokens("{{custom_x}}", {}, blank), "", "unknown CUSTOM token → blank, not {{custom_x}} (THE leak fix)");
eq(applyTokens("{{custom_x|}}", {}), "", "explicit empty inline default → blank");
eq(applyTokens("{{constructor}}", {}, blank), "", "Object.prototype key resolves to blank, never a function");

console.log("\napplyTokens — preview behavior preserved (no fallback fn)");
eq(applyTokens("Hi {{first_name}}", {}), "Hi {{first_name}}", "no map + no fallback → left untouched (author sees typo)");
eq(applyTokens("{{constructor}}", {}), "{{constructor}}", "prototype key left untouched, not the Object function");
eq(applyTokens("Hi {{first_name}}", { firstname: "" }), "Hi ", "present-but-empty + no fallback → blank (prior behavior kept)");

console.log("\nextractCampaignTokens — strip |default + classify");
{
  const info = extractCampaignTokens(["Hi {{first_name|there}}, from {{company}}"]);
  eq(info.standard.length, 2, "two standard tokens");
  eq(info.standard[0].token, "first_name", "token spelling has NO |default appended");
  eq(info.standard[0].key, "firstname", "key normalized from the NAME only");
  eq(info.standard[0].hasFallback, true, "first_name has an inline default");
  eq(info.standard[1].hasFallback, false, "company has no inline default");
  eq(info.custom.length, 0, "no custom tokens here");
}
eq(
  extractCampaignTokens(["{{your_name}} {{sender_name}}"]),
  { standard: [], custom: [] },
  "sender-identity tokens are excluded",
);

console.log("\nextractCampaignTokens — hasFallback is AND across occurrences");
eq(extractCampaignTokens(["{{x|d}}"]).custom[0].hasFallback, true, "single defaulted use → protected");
eq(extractCampaignTokens(["{{x}} {{x|d}}"]).custom[0].hasFallback, false, "one bare use → NOT protected");
eq(extractCampaignTokens(["{{x|d}} {{x|e}}"]).custom[0].hasFallback, true, "every use defaulted → protected");
{
  const info = extractCampaignTokens(["{{Property Address}}"]);
  eq(info.custom.length, 1, "unknown token classified as custom");
  eq(info.custom[0].key, "propertyaddress", "custom key normalized");
}

console.log("\nallEmailTemplates + extraction — catches B/C variants AND branch tokens");
{
  const graph: FlowGraph = {
    version: 1,
    nodes: [
      {
        id: "e1",
        kind: "email",
        subject: "A {{first_name}}",
        body: "A body {{company}}",
        variants: [{ id: "e1b", subject: "B {{title}}", body: "B body {{industry}}" }],
      },
      {
        id: "c1",
        kind: "condition",
        trigger: "replied",
        yes: [{ id: "e2", kind: "email", subject: "Y {{yes_var}}", body: "yb" }],
        no: [{ id: "e3", kind: "email", subject: "", body: "No {{no_var}}" }],
      },
    ],
  };
  const templates = allEmailTemplates(graph);
  eq(templates.includes("B body {{industry}}"), true, "collects a B-variant body");
  eq(templates.includes("Y {{yes_var}}"), true, "collects a yes-branch subject");
  const keys = extractCampaignTokens(templates).custom.map((t) => t.key).sort();
  eq(keys, ["industry", "novar", "yesvar"], "extracts custom tokens from every variant + branch");
}

console.log("\nreconcileCampaignVariables — ordered de-duped union");
{
  const existing: CampaignVariable[] = [{ token: "OldVar", key: "oldvar", kind: "custom" }];
  const copy = extractCampaignTokens(["{{first_name}} {{new_var}}"]);
  const mapped = [{ token: "CsvOnly", key: "csvonly" }];
  const out = reconcileCampaignVariables(existing, copy, mapped);
  eq(
    out.map((v) => v.key),
    ["oldvar", "firstname", "csvonly"],
    "order: existing → copy standard → mapped custom (copy CUSTOM never registers)",
  );
  eq(out.find((v) => v.key === "newvar"), undefined, "a copy-only custom token is NOT registered (columns drive customs)");
  eq(out.find((v) => v.key === "firstname")?.kind, "standard", "first_name classified standard");
  eq(out.find((v) => v.key === "csvonly")?.kind, "custom", "csv-only column classified custom");
}
{
  // An already-registered custom (from an earlier mapping) carries forward; a copy
  // token that normalizes to it does NOT add a duplicate (copy customs don't register).
  const existing: CampaignVariable[] = [{ token: "PropertyAddress", key: "propertyaddress", kind: "custom" }];
  const copy = extractCampaignTokens(["{{property address}}"]);
  const out = reconcileCampaignVariables(existing, copy, []);
  eq(out.length, 1, "same key not duplicated");
  eq(out[0].token, "PropertyAddress", "existing spelling wins");
}
eq(reconcileCampaignVariables(null, { standard: [], custom: [] }, []), [], "empty everything → []");

console.log("\nbuildInitialMappingForTargets — columns drive new variables");
eq(
  buildInitialMappingForTargets(["Property Address"], null, []),
  { "Property Address": CUSTOM_TARGET_PREFIX + "Property Address" },
  "an UNMATCHED column → a new custom variable named after it (not dropped)",
);
{
  const m = buildInitialMappingForTargets(["Email", "First Name"], null, []);
  eq(m["Email"], "email", "standard column auto-maps to its field");
  eq(m["First Name"], "first_name", "aliased standard column auto-maps");
}
eq(
  buildInitialMappingForTargets(["Property Address"], null, [{ token: "PropertyAddress", key: "propertyaddress" }]),
  { "Property Address": CUSTOM_TARGET_PREFIX + "PropertyAddress" },
  "a same-name column re-uses an existing variable's spelling",
);
eq(buildInitialMappingForTargets(["Your Name"], null, []), { "Your Name": "" }, "a sender-token column is skipped, not custom");
eq(buildInitialMappingForTargets(["---"], null, []), { "---": "" }, "a punctuation-only header is skipped");

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
