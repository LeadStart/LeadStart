// Drift guard for the in-app Enrichment Flow Map.
//
// The map (src/components/workflows/enrichment-flow-map.data.ts) hard-declares a
// few things that can't be a live import: the Apify/provider actor IDs and the
// activity post-sample count. This test extracts the CURRENT values from the
// real source and fails if the map hasn't kept up, so "they MUST stay synced"
// is enforced, not remembered. Costs + default behaviour are auto-synced (the
// data module imports the live constants), and this test also asserts that
// wiring is still in place.
//
// Run:  npx tsx scripts/test-flow-map-sync.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}
function extract(rel: string, re: RegExp, label: string): string | null {
  const m = read(rel).match(re);
  if (!m) {
    fail++;
    console.log(`  ✗ could not find ${label} in ${rel} (renamed? update the extractor + the map)`);
    return null;
  }
  return m[1];
}

const DATA = "src/components/workflows/enrichment-flow-map.data.ts";
const dataText = read(DATA);

// ---- actor IDs: extract the live value from source, assert the map shows it ----
console.log("actor IDs (source → flow map)");
const ACTORS: { name: string; src: string; re: RegExp }[] = [
  { name: "profile-search", src: "src/lib/apify/sourcing/profile-search.ts", re: /PROFILE_SEARCH_ACTOR_ID\s*=\s*"([^"]+)"/ },
  { name: "profile-scraper", src: "src/lib/apify/providers/profile-harvestapi.ts", re: /PROFILE_ACTOR_ID\s*=\s*"([^"]+)"/ },
  { name: "linkedin-company", src: "src/lib/apify/providers/company-harvestapi.ts", re: /DOMAIN_ACTOR_ID\s*=\s*"([^"]+)"/ },
  { name: "profile-posts", src: "src/lib/apify/providers/activity-harvestapi.ts", re: /ACTIVITY_ACTOR_ID\s*=\s*"([^"]+)"/ },
  { name: "site-contact-scraper", src: "src/lib/apify/providers/waterfall-scrape.ts", re: /WATERFALL_SCRAPE_ACTOR_ID\s*=[\s\S]{0,140}?"([^"]+site-contact-scraper[^"]*)"/ },
  { name: "google-maps-extractor", src: "src/lib/apify/sourcing/maps-search.ts", re: /MAPS_SEARCH_ACTOR_ID\s*=[\s\S]{0,140}?"([^"]+google-maps-extractor[^"]*)"/ },
];
for (const a of ACTORS) {
  const id = extract(a.src, a.re, `${a.name} actor id`);
  if (id == null) continue;
  const namePart = id.includes("~") ? id.split("~").pop()! : id; // map shows short form for site_scrape
  ok(dataText.includes(namePart), `map shows "${a.name}" (${id})`);
}

// ---- activity post count: map claims "N post sampled" ----
console.log("activity sample count");
const maxPosts = extract("src/lib/apify/providers/activity-harvestapi.ts", /MAX_POSTS\s*=\s*(\d+)/, "MAX_POSTS");
if (maxPosts != null) ok(dataText.includes(`${maxPosts} post`), `map claims "${maxPosts} post sampled"`);

// ---- auto-sync wiring: costs + defaults must be imported, not hard-typed ----
console.log("auto-sync wiring (costs + defaults are live imports)");
ok(/from ["']@\/lib\/apify\/pricing["']/.test(dataText), "imports pricing constants");
ok(/from ["']@\/types\/app["']/.test(dataText), "imports DEFAULT_ENRICHMENT_SETTINGS / ADDONS");
ok(/PROFILE_EMAIL_COST_USD/.test(dataText) && /MV_CREDIT_COST_USD/.test(dataText), "derives profile + MV cost from constants");
ok(/DEFAULT_ENRICHMENT_ADDONS/.test(dataText) || /ADDONS\./.test(dataText), "derives add-on default labels from config");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
