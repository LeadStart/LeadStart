#!/usr/bin/env node
/**
 * Unit tests for the Google-Maps multi-region FAN-OUT helpers (Phase 2):
 * area coercion/validation, per-area cap division, cross-area dedupe union, and
 * the ingest→accumulate→slice step the run-maps-searches cron runs once per area.
 * No network, no DB. Run: npx tsx scripts/test-maps-fanout.ts
 */
import {
  coerceMapsArea,
  coerceMapsAreas,
  perAreaMaxItems,
  mergeMapsPlaces,
  ingestAreaResult,
} from "../src/lib/apify/sourcing/maps-search.ts";
import type { MapsPlace } from "../src/types/app.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${g}, want ${w})`);
  }
}
function ok(cond: boolean, msg: string) {
  eq(Boolean(cond), true, msg);
}

// Compact MapsPlace factory: only the id matters for dedupe/order tests.
function place(id: string, name?: string): MapsPlace {
  return {
    google_place_id: id,
    name: name ?? id,
    category: null,
    category_label: null,
    categories: [],
    website: null,
    company_domain: null,
    phone: null,
    full_address: null,
    street: null,
    city: null,
    state: null,
    postal_code: null,
    country_code: null,
    latitude: null,
    longitude: null,
    rating: null,
    reviews_count: null,
    maps_url: null,
    temporarily_closed: false,
    claimed: null,
  };
}

console.log("coerceMapsArea, validation + normalization");
eq(coerceMapsArea({ level: "city", name: "Dallas", state: "Texas" }), { level: "city", countryCode: "us", name: "Dallas", state: "Texas" }, "city → keeps name+state, country defaults us");
eq(coerceMapsArea({ level: "county", name: "Dallas County", state: "Texas" }), { level: "county", countryCode: "us", name: "Dallas County", state: "Texas" }, "county → name+state");
eq(coerceMapsArea({ level: "state", state: "Texas" }), { level: "state", countryCode: "us", state: "Texas" }, "state → state only");
eq(coerceMapsArea({ level: "zip", postalCode: "75201" }), { level: "zip", countryCode: "us", postalCode: "75201" }, "zip → postalCode only");
eq(coerceMapsArea({ level: "city", name: " Austin ", state: " Texas ", label: " Austin, TX " }), { level: "city", countryCode: "us", name: "Austin", state: "Texas", label: "Austin, TX" }, "trims name/state/label");
eq(coerceMapsArea({ level: "zip", postalCode: "10001", countryCode: "US" }), { level: "zip", countryCode: "us", postalCode: "10001" }, "countryCode lowercased");
eq(coerceMapsArea({ level: "city", name: "Dallas" }), null, "city with NO state → rejected (would widen nationwide)");
eq(coerceMapsArea({ level: "county", state: "Texas" }), null, "county with no name → rejected");
eq(coerceMapsArea({ level: "state" }), null, "state with no state → rejected");
eq(coerceMapsArea({ level: "zip" }), null, "zip with no postalCode → rejected");
eq(coerceMapsArea({ level: "metro", name: "DFW" }), null, "unknown level → rejected (metro removed)");
eq(coerceMapsArea(null), null, "null → rejected");
eq(coerceMapsArea("Dallas, TX"), null, "string → rejected");

console.log("coerceMapsAreas, filter + order");
const areas = coerceMapsAreas([
  { level: "city", name: "Dallas", state: "Texas" },
  { level: "city", name: "Broken" }, // no state → dropped
  { level: "zip", postalCode: "10001" },
]);
eq(areas.length, 2, "drops the invalid area, keeps 2");
eq(areas[0].name, "Dallas", "order preserved (Dallas first)");
eq(areas[1].postalCode, "10001", "zip second");
eq(coerceMapsAreas(undefined), [], "undefined → []");
eq(coerceMapsAreas("nope"), [], "non-array → []");
eq(coerceMapsAreas([]), [], "empty → []");

console.log("perAreaMaxItems, ceil division, clamped");
eq(perAreaMaxItems(200, 1), 200, "1 area → full target");
eq(perAreaMaxItems(200, 2), 100, "2 areas → half");
eq(perAreaMaxItems(200, 3), 67, "3 areas → ceil(200/3)=67 (union can still reach 200)");
eq(perAreaMaxItems(250, 4), 63, "ceil(250/4)=63");
eq(perAreaMaxItems(1, 5), 1, "target 1 across 5 → at least 1");
eq(perAreaMaxItems(0, 2), 1, "target 0 → clamped to 1");
eq(perAreaMaxItems(100, 0), 100, "areaCount 0 → treated as 1");

console.log("mergeMapsPlaces, dedupe union, existing-wins, order-stable");
eq(mergeMapsPlaces([place("a"), place("b")], [place("b"), place("c")]).map((p) => p.google_place_id), ["a", "b", "c"], "union dedupes the shared id");
eq(mergeMapsPlaces([place("a", "First")], [place("a", "Second")])[0].name, "First", "existing wins on collision");
eq(mergeMapsPlaces([], [place("x")]).map((p) => p.google_place_id), ["x"], "empty existing → incoming");
eq(mergeMapsPlaces([place("x")], []).map((p) => p.google_place_id), ["x"], "empty incoming → existing");
{
  const noId = { ...place("keep") };
  const bad = { ...place("z"), google_place_id: "" } as MapsPlace;
  eq(mergeMapsPlaces([noId], [bad]).length, 1, "drops a place with a blank id");
}

console.log("ingestAreaResult, accumulate → advance / finalize");
// Area 1 of 2 → not done, accumulation = this area, cursor advances.
const s1 = ingestAreaResult({ areaIndex: 0, areaCount: 2, accumulated: [], incoming: [place("a"), place("b")], target: 10 });
ok(!s1.done, "area 1 of 2 → not done");
eq(s1.nextAreaIndex, 1, "cursor advances to 1");
eq(s1.accumulated.map((p) => p.google_place_id), ["a", "b"], "accumulation = area 1's places");
eq(s1.finalResults, undefined, "no finalResults until done");

// Area 2 of 2 with an overlapping place → done, deduped union.
const s2 = ingestAreaResult({ areaIndex: 1, areaCount: 2, accumulated: s1.accumulated, incoming: [place("b"), place("c")], target: 10 });
ok(s2.done, "area 2 of 2 → done");
eq(s2.nextAreaIndex, 2, "cursor now equals areaCount");
eq(s2.finalResults?.map((p) => p.google_place_id), ["a", "b", "c"], "final union deduped across areas (b once)");
ok(!s2.truncated, "union (3) ≤ target (10) → not truncated");

// Single area → done immediately.
const single = ingestAreaResult({ areaIndex: 0, areaCount: 1, accumulated: [], incoming: [place("a")], target: 50 });
ok(single.done, "areaCount 1 → done on first ingest");
eq(single.finalResults?.length, 1, "single-area finalResults present");

// Truncation: union exceeds the target → sliced + flagged.
const trunc = ingestAreaResult({
  areaIndex: 1,
  areaCount: 2,
  accumulated: [place("a"), place("b"), place("c")],
  incoming: [place("d"), place("e")],
  target: 4,
});
ok(trunc.done, "truncation case: done");
eq(trunc.finalResults?.length, 4, "finalResults sliced to target (4)");
eq(trunc.finalResults?.map((p) => p.google_place_id), ["a", "b", "c", "d"], "keeps the first `target` of the union");
ok(trunc.truncated === true, "union (5) > target (4) → truncated");

// Exact fit: union == target → not truncated.
const exact = ingestAreaResult({ areaIndex: 1, areaCount: 2, accumulated: [place("a"), place("b")], incoming: [place("c"), place("d")], target: 4 });
eq(exact.finalResults?.length, 4, "exact-fit keeps all 4");
ok(!exact.truncated, "union == target → not truncated");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
