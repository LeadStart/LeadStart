#!/usr/bin/env node
/**
 * Unit tests for the TuBe handoff export (src/lib/tube/handoff.ts): the sheet
 * LeadStart hands TuBe SEO's AI-visibility scan. Every case here is a failure the
 * 2026-09-10 WA law-firm run actually hit (wrong city, "businesses like this",
 * category labels, nobody to email, the firm's legal name not recognised).
 * No network, no DB. Run: npx tsx scripts/test-tube-handoff.ts
 */
import {
  TUBE_UPLOAD_COLUMNS,
  buildTubeHandoff,
  firmAliases,
  icpExclusion,
  practiceArea,
  seedQuery,
  shortCompany,
  stateAbbrev,
  tubeUploadTable,
  type TubeContactInput,
  type TubeFirmInput,
} from "../src/lib/tube/handoff.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

console.log("stateAbbrev");
eq(stateAbbrev("Washington"), "WA", "full name → code");
eq(stateAbbrev("wa"), "WA", "code is upper-cased");
eq(stateAbbrev(""), "", "blank → blank");

console.log("practiceArea (customer phrasing from Google categories)");
eq(practiceArea(["Attorney", "Personal injury attorney", "Trial attorney"], "X", "x.com").phrase, "personal injury lawyers", "skips generic 'Attorney', takes the first specific practice");
eq(practiceArea(["Law firm", "Family law attorney", "Divorce lawyer"], "X", "x.com").phrase, "family law attorneys", "listing order decides between two specifics");
eq(practiceArea(["Criminal justice attorney"], "X", "x.com").phrase, "criminal defense attorneys", "Google's 'criminal justice' → how customers ask");
eq(practiceArea(["Elder law attorney"], "X", "x.com").phrase, "elder law attorneys", "mapped specific");
eq(practiceArea(["Maritime attorney"], "X", "x.com").phrase, "maritime attorneys", "unmapped '<x> attorney' is pluralised as-is");
{
  const p = practiceArea(["Attorney", "Law firm"], "Olympia Injury Law", "olyinjurylaw.com");
  eq([p.phrase, p.source], ["personal injury lawyers", "name"], "generic-only listing: practice inferred from the firm's name");
}
eq(practiceArea(["Attorney"], "Summit Real Estate Law", "summitrelaw.com").phrase, "real estate attorneys", "'Real Estate' is not read as estate planning");
{
  const p = practiceArea(["Attorney", "Law firm"], "Carney & Marchi", "carneymarchi.com");
  eq([p.phrase, p.specific], ["lawyers", false], "nothing specific → broad 'lawyers', flagged not specific");
}
eq(practiceArea(["Commercial cleaning service"], "X", "x.com").phrase, "commercial cleaning services", "non-law vertical pluralises its category");
eq(practiceArea([], "Acme", "acme.com").phrase, "", "no categories and no name hint → no question at all");

console.log("seedQuery");
eq(seedQuery("personal injury lawyers", "Tacoma", "WA"), "Who are the best personal injury lawyers in Tacoma, WA?", "exact question, city + state locked");

console.log("icpExclusion");
eq(icpExclusion("FisherBroyles", "fisherbroyles.com", ["Law firm"]), "large_firm", "large firm");
eq(icpExclusion("Columbia Legal Services", "columbialegal.org", ["Legal services"]), "public_or_nonprofit", "legal aid nonprofit");
eq(icpExclusion("Smith Law", "smithlaw.org", ["Attorney"]), "public_or_nonprofit", ".org with no for-profit suffix");
eq(icpExclusion("Smith Law, PLLC", "smithlaw.org", ["Attorney"]), null, ".org with PLLC stays in");
eq(icpExclusion("Some Clinic", "someclinic.com", ["Non-profit organization"]), "public_or_nonprofit", "nonprofit category");
eq(icpExclusion("Tamaki Law", "tamakilaw.com", ["Personal injury attorney"]), null, "ordinary firm stays in");

console.log("shortCompany (subject-line name)");
eq(shortCompany("McNeese & Trotsky - Accident Attorneys"), "McNeese & Trotsky", "drops listing tail");
eq(shortCompany("Davies Pearson, P.C."), "Davies Pearson", "drops P.C.");
eq(shortCompany("Leavy Schultz Davis, P.S. - Kennewick Car Accident Lawyer"), "Leavy Schultz Davis", "drops P.S. and tail");
eq(shortCompany("Rio Foltz, PLLC"), "Rio Foltz", "drops PLLC");

console.log("firmAliases (every name the AI might use)");
const owner = (over: Partial<TubeContactInput> = {}): TubeContactInput => ({
  first_name: "Bryan", last_name: "Johnson", company_name: "Church Rietzke Johnson PLLC",
  email: "bryan@olyinjurylaw.com", email_verification_status: "ok", ...over,
});
eq(firmAliases("Olympia Injury Law", owner()), ["Olympia Injury Law", "Church Rietzke Johnson", "Bryan Johnson"], "listing name, legal name, owner");
eq(firmAliases("Tamaki Law", owner({ company_name: "tamaki law", first_name: null, last_name: null })), ["Tamaki Law"], "case-insensitive dedupe, no owner");
eq(firmAliases("AEON Law - Patent, Trademark, and Copyright Attorneys", owner({ company_name: null, first_name: "Adam", last_name: "Philipp" })), ["AEON Law", "Adam Philipp"], "listing tail dropped: practice words are not identity");

console.log("buildTubeHandoff");
const firm = (over: Partial<TubeFirmInput> = {}): TubeFirmInput => ({
  placeName: "Olympia Injury Law", categories: ["Attorney", "Personal injury attorney"],
  city: "Olympia", state: "Washington", domain: "https://www.olyinjurylaw.com/", contact: owner(), ...over,
});
{
  const { rows } = buildTubeHandoff([firm()]);
  eq(rows.length, 1, "an emailable firm becomes one row");
  const r = rows[0];
  eq(r.domain, "olyinjurylaw.com", "domain normalised (no scheme/www/path)");
  eq(r.business_type, "personal injury lawyers", "business_type in customer words");
  eq(r.seed_query, "Who are the best personal injury lawyers in Olympia, WA?", "seed_query is the exact question");
  eq(r.markets, "Olympia, WA", "markets locks city + state");
  eq(r.company, "Olympia Injury Law", "company = the brand customers know (listing name), not the legal entity");
  eq(r.aliases, "Olympia Injury Law; Church Rietzke Johnson; Bryan Johnson", "aliases carried for self-mention checks");
}
{
  const cases: [string, TubeFirmInput, string][] = [
    ["no website", firm({ domain: null }), "no_website"],
    ["large firm", firm({ placeName: "FisherBroyles", domain: "fisherbroyles.com" }), "large_firm"],
    ["public body", firm({ placeName: "Northwest Justice Project", domain: "nwjustice.org" }), "public_or_nonprofit"],
    ["not imported", firm({ contact: null }), "not_in_contacts"],
    ["no owner", firm({ contact: owner({ first_name: null }) }), "no_owner_name"],
    ["catch-all guess", firm({ contact: owner({ email_provider_status: "catch_all" }) }), "email_not_verified"],
    ["never verified", firm({ contact: owner({ email_verification_status: null }) }), "email_not_verified"],
    ["generic inbox", firm({ contact: owner({ email_kind: "company_generic" }) }), "email_not_verified"],
    ["no city", firm({ city: null }), "no_city"],
    ["generic practice", firm({ placeName: "Carney & Marchi", domain: "carneymarchi.com", categories: ["Attorney", "Law firm"] }), "no_specific_practice"],
  ];
  for (const [label, f, want] of cases) {
    const { rows, skipped } = buildTubeHandoff([f]);
    eq([rows.length, skipped[0]?.reason], [0, want], `skipped: ${label}`);
  }
}
{
  const generic = firm({ placeName: "Carney & Marchi", domain: "carneymarchi.com", categories: ["Attorney", "Law firm"] });
  const off = buildTubeHandoff([generic]);
  eq(off.genericCount, 1, "generic firms are counted so the UI can offer them");
  const on = buildTubeHandoff([generic], { includeGeneric: true });
  eq(on.rows[0]?.seed_query, "Who are the best lawyers in Olympia, WA?", "opt-in: generic firm gets the broad question");
}
{
  const { rows, skipped } = buildTubeHandoff([firm(), firm({ placeName: "Olympia Injury Law (Lacey)", city: "Lacey" })]);
  eq([rows.length, skipped[0]?.reason], [1, "duplicate_website"], "one row per website (multi-office firms scan once)");
}
{
  const accountant = firm({ placeName: "Smith CPA", domain: "smithcpa.com", categories: ["Certified public accountant"] });
  const law = [firm(), firm({ placeName: "Tamaki Law", domain: "tamakilaw.com" }), accountant];
  const { rows, skipped } = buildTubeHandoff(law);
  eq([rows.length, skipped.map((s) => s.reason)], [2, ["off_vertical"]], "a mostly-law list drops the accountant the search returned");
  const cleaning = buildTubeHandoff([firm({ placeName: "Sparkle Co", domain: "sparkle.com", categories: ["Commercial cleaning service"] })]);
  eq(cleaning.rows[0]?.business_type, "commercial cleaning services", "a non-law list keeps its own vertical");
}

console.log("TuBe upload contract (mirrors AdminDashboard.jsx parseCsv header matching)");
const { headers } = tubeUploadTable([]);
eq(headers, [...TUBE_UPLOAD_COLUMNS], "headers in contract order");
const find = (re: RegExp) => headers.findIndex((h) => re.test(h.toLowerCase()));
eq(find(/domain|website|web site|\burl\b|homepage|^site$/), 0, "TuBe finds the domain column");
eq(find(/business.?type|industry|category|practice|niche|vertical|^type$/), 1, "TuBe finds business_type (no earlier 'category' header)");
eq(find(/seed|keyword|query/), 2, "TuBe finds seed_query");
eq(find(/market|city|cities|location|service.?area|^area$/), 3, "TuBe takes markets, not the bare city column");
eq(find(/alias/), headers.indexOf("aliases"), "TuBe finds aliases");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
