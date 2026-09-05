#!/usr/bin/env node
/**
 * Unit tests for the shared waterfall-routing module (name-aware method routing).
 * No network, no DB. Run: npx tsx scripts/test-waterfall-routing.ts
 */
import { hasUsableName, methodForItem } from "../src/lib/enrichment/waterfall-routing.ts";
import { DEFAULT_ENRICHMENT_SETTINGS, type EnrichmentSettings } from "../src/types/app.ts";

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

console.log("hasUsableName");
eq(hasUsableName("Mark", "Salek"), true, "both names");
eq(hasUsableName("Mark", null), true, "first only");
eq(hasUsableName(null, "Salek"), true, "last only");
eq(hasUsableName(null, null), false, "no name");
eq(hasUsableName("", "  "), false, "blank strings");
eq(hasUsableName("A", null), false, "single-char first is not usable");
eq(hasUsableName("Jo", null), true, "2-char first is usable");

const cfg = (over: Partial<EnrichmentSettings>): EnrichmentSettings => ({ ...DEFAULT_ENRICHMENT_SETTINGS, ...over });

console.log("methodForItem, named items keep their band method");
eq(methodForItem(cfg({ unknown_method: "pattern_mv" }), null, true), "pattern_mv", "named + unknown band = pattern_mv");
eq(methodForItem(cfg({ small_method: "pattern_mv" }), 10, true), "pattern_mv", "named + small band");
eq(methodForItem(cfg({ large_method: "bovi" }), 500, true), "bovi", "named + large band = bovi");
eq(methodForItem(cfg({ unknown_method: "site_scrape" }), null, true), "site_scrape", "named + site_scrape stays");
eq(methodForItem(cfg({ unknown_method: "off" }), null, true), "off", "named + off stays off");

console.log("methodForItem, name-less items force site_scrape for name-based methods");
eq(methodForItem(cfg({ unknown_method: "pattern_mv" }), null, false), "site_scrape", "nameless + pattern_mv → site_scrape");
eq(methodForItem(cfg({ unknown_method: "bovi" }), null, false), "site_scrape", "nameless + bovi → site_scrape");
eq(
  methodForItem(cfg({ unknown_method: "scrape_plus_pattern" }), null, false),
  "site_scrape",
  "nameless + scrape_plus_pattern → site_scrape (pattern stage impossible)",
);
eq(methodForItem(cfg({ unknown_method: "site_scrape" }), null, false), "site_scrape", "nameless + site_scrape stays");
eq(methodForItem(cfg({ unknown_method: "off" }), null, false), "off", "nameless + off stays off (no wasted work)");

console.log("methodForItem, size banding still applies");
eq(
  methodForItem(cfg({ size_threshold: 50, small_method: "site_scrape", large_method: "pattern_mv" }), 10, true),
  "site_scrape",
  "10 employees < 50 → small band",
);
eq(
  methodForItem(cfg({ size_threshold: 50, small_method: "site_scrape", large_method: "pattern_mv" }), 200, true),
  "pattern_mv",
  "200 employees ≥ 50 → large band",
);

console.log(`\nwaterfall-routing: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
