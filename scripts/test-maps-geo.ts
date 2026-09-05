#!/usr/bin/env node
/**
 * Unit tests for the Google-Maps structured-geo / multi-region input builders.
 * Verifies each area level maps to the compass actor's exact structured fields
 * (Country ⊃ State ⊃ County ⊃ City; ZIP = Country only), that the structured
 * path never emits `locationQuery`, and that the legacy free-text path is intact.
 * No network, no DB. Run: npx tsx scripts/test-maps-geo.ts
 */
import {
  buildMapsSearchInput,
  buildMapsSearchInputForArea,
  geoFieldsForArea,
  type MapsSearchLevers,
} from "../src/lib/apify/sourcing/maps-search.ts";

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

const levers: MapsSearchLevers = {
  searchTerms: ["med spa", "medical spa"],
  websiteFilter: "with",
  minStars: "4.0",
};

console.log("geoFieldsForArea, level → actor fields");
const city = geoFieldsForArea({ level: "city", name: "Dallas", state: "Texas" });
eq(city.city, "Dallas", "city → city");
eq(city.state, "Texas", "city → state (full name)");
eq(city.countryCode, "us", "city → country defaults us");
ok(!("county" in city) && !("postalCode" in city) && !("locationQuery" in city), "city: no county/zip/locationQuery");

const county = geoFieldsForArea({ level: "county", name: "Dallas County", state: "Texas" });
eq(county.county, "Dallas County", "county → county");
eq(county.state, "Texas", "county → state");
ok(!("city" in county), "county: no city field");

const state = geoFieldsForArea({ level: "state", state: "Texas" });
eq(state.state, "Texas", "state → state");
ok(!("county" in state) && !("city" in state) && !("postalCode" in state), "state: state + country only");

const zip = geoFieldsForArea({ level: "zip", postalCode: "75201" });
eq(zip.postalCode, "75201", "zip → postalCode");
eq(zip.countryCode, "us", "zip → country us");
ok(!("city" in zip) && !("state" in zip) && !("county" in zip), "zip: Country + postalCode ONLY (never city/state/county)");

console.log("buildMapsSearchInputForArea, structured, no locationQuery");
const inCounty = buildMapsSearchInputForArea(
  levers,
  { level: "county", name: "Dallas County", state: "Texas" },
  { maxItems: 250 },
);
ok(!("locationQuery" in inCounty), "structured build emits NO locationQuery (would override geolocation)");
eq((inCounty.searchStringsArray as string[]).length, 2, "carries both search terms");
eq(inCounty.county, "Dallas County", "structured county field present");
eq(inCounty.state, "Texas", "structured state field present");
eq(inCounty.website, "withWebsite", "filter: website applied");
eq(inCounty.placeMinimumStars, "4.0", "filter: minStars applied");
eq(inCounty.maxCrawledPlacesPerSearch, 125, "per-search cap = ceil(250 / 2 terms)");
eq(inCounty.scrapePlaceDetailPage, false, "detail page off");
eq(inCounty.scrapeContacts, false, "actor contacts off");

const zipInput = buildMapsSearchInputForArea({ searchTerms: ["gym"] }, { level: "zip", postalCode: "10001" }, { maxItems: 100 });
eq(zipInput.postalCode, "10001", "zip build → postalCode");
ok(!("city" in zipInput) && !("state" in zipInput), "zip build: no city/state");
eq(zipInput.maxCrawledPlacesPerSearch, 100, "single term → full cap per search");

console.log("buildMapsSearchInput, legacy free-text still intact");
const legacy = buildMapsSearchInput({ searchTerms: ["dentist"], locationQuery: "Dallas, TX" }, { maxItems: 100 });
eq(legacy.locationQuery, "Dallas, TX", "legacy sets locationQuery");
ok(!("city" in legacy) && !("state" in legacy) && !("county" in legacy), "legacy: no structured fields");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
