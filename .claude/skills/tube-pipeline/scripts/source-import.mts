// Step 3a: import the reviewed firms into LeadStart. DRY RUN unless --apply.
//
//   npx tsx --tsconfig scripts/tsconfig.harness.json .claude/skills/tube-pipeline/scripts/source-import.mts --run <name> [--apply]
//
// (The harness tsconfig stubs `server-only`, which the app's server modules import.)
// Goes through the app's REAL code, exactly what Prospecting → Local businesses
// → save runs: a maps_searches row (the firms, the brief's filters, the credits
// spent, every exclusion) and importMapsPlaces, which stamps each firm's email
// host, sets weak email hosts aside (pooled-weak-host), and skips firms already
// in Contacts. The enrichment add-ons come from the brief and ride on the row.
// Imported contacts are tagged "scrap.io" + "tube-<run>". Enrichment is NOT
// started here: that's enrich.mts, after the owner's go on its cost.
import {
  ORG_ID, args, assertRepoCwd, existsSync, fmtTally, getIn, importRepo, join, loadEnvIntoProcess, main, readJson, readRun, runDir, saveRun,
  stamp, tally, writeJson,
} from "./lib.mjs";

main(async () => {
  assertRepoCwd();
  loadEnvIntoProcess();
  const { createAdminClient } = await importRepo("src/lib/supabase/admin.ts");
  const { importMapsPlaces } = await importRepo("src/lib/apify/import-maps-places.ts");
  const a = args();
  const APPLY = a.apply === true;
  const dir = runDir(a.run);
  const brief = existsSync(join(dir, "brief.json")) ? readJson(join(dir, "brief.json")) : null;
  if (!brief?.confirmed_at) throw new Error(`Run "${a.run}": no confirmed brief.`);
  const keptFile = join(dir, "source-kept.json");
  if (!existsSync(keptFile)) throw new Error(`${keptFile} not found: run source-review.mts first`);
  const prior = join(dir, "source-import.json");
  if (existsSync(prior)) throw new Error(`This run already imported (${prior}). Nothing to do.`);
  const bank = brief.mode === "bank";
  // A bank run's review (bank-review.mts) adds each business's own signal tags.
  const placeTags = new Map<string, string[]>();
  const places = readJson(keptFile).map(({ _query_city, _group, _tags, ...p }: Record<string, any>) => {
    if (Array.isArray(_tags)) placeTags.set(p.google_place_id, _tags);
    return p;
  });
  if (!places.length) throw new Error("source-kept.json is empty: nothing to import.");
  const excluded = existsSync(join(dir, "source-excluded.json")) ? readJson(join(dir, "source-excluded.json")) : [];
  const pull = existsSync(join(dir, "scrapio-pull.json")) ? readJson(join(dir, "scrapio-pull.json")) : null;

  const already = await getIn((l: string) => `contacts?select=google_place_id&organization_id=eq.${ORG_ID}&google_place_id=in.${l}`, places.map((p: any) => p.google_place_id), 100);
  const tags = ["scrap.io", bank ? a.run : `tube-${a.run}`];
  const addons = {
    naming: brief.enrichment?.naming !== false,
    verify: true,
    include_catch_all: true,
    validate_catch_all: brief.enrichment?.catch_all_recovery === true,
  };
  // A bank pull stops when its searches run out: name only the cities it reached.
  const metros = bank
    ? [...new Set(((pull?.tally ?? []) as any[]).filter((t) => t.pages > 0).map((t) => t.city as string))]
    : brief.area?.metros ?? [];
  console.log(`Run "${a.run}" · ${APPLY ? "APPLY" : "dry run"} · ${places.length} reviewed firms · already in Contacts ${already.length} (importMapsPlaces skips them)`);
  console.log(`Cities: ${fmtTally(tally(places.map((p: any) => p.city ?? "?")))}`);
  console.log(`Enrichment add-ons (from the brief): owner names ${addons.naming ? "on" : "off"} · email checks on · catch-all recovery ${addons.validate_catch_all ? "on" : "off"}. Weak email hosts are set aside at import.`);
  console.log(`Tags: ${tags.join(", ")}${placeTags.size ? ` + each business's own: ${fmtTally(tally([...placeTags.values()].flat()))}` : ""}`);
  if (!APPLY) {
    console.log("DRY RUN: nothing written. Importing adds contacts (no cost); enrichment is the next step and costs money.");
    return;
  }

  const admin = createAdminClient();
  // Attributed to the org owner, as the app's own enrichment cron does.
  const { data: owner } = await admin.from("profiles").select("id").eq("organization_id", ORG_ID).eq("role", "owner").limit(1).maybeSingle();
  if (!owner) throw new Error("no owner profile in the org");
  const now = new Date().toISOString();
  const excludedSummary = excluded.map((e: Record<string, unknown>) => ({ name: e.name, city: e.city, reason: e.reason, detail: e.detail }));
  const query = bank
    ? {
        name: `${brief.vertical ?? "Bank pull"} · ${a.run}: ${metros.length} US cities (Scrap.io, not enriched)`,
        source: "scrapio",
        levers: {
          searchTerms: Object.values(brief.groups ?? {}).flatMap((g: any) => g.types),
          locationQuery: metros.join("; "),
          websiteFilter: "with",
        },
        addons,
        scrapio: {
          run: a.run, mode: "bank", cities: brief.area?.cities, groups: brief.groups,
          gmap_has_website: 1, gmap_is_closed: 0,
          credits: pull ? { spent: pull.credits_spent ?? pull.spent, searches: pull.searches_used ?? null, by_city_group: pull.tally } : null,
          excluded: excludedSummary,
        },
      }
    : {
        name: `${brief.area?.state} law firms · ${a.run}: ${metros.join(", ")} (Scrap.io, ${brief.filters?.min_reviews ?? 10}+ reviews)`,
        source: "scrapio",
        levers: { searchTerms: ["attorney", "law firm"], locationQuery: metros.map((c: string) => `${c}, ${brief.area?.state}`).join("; "), websiteFilter: "with" },
        addons,
        scrapio: {
          run: a.run, cities: metros, admin1_code: brief.area?.state, groups: brief.practice?.groups, caps: brief.area?.caps ?? {},
          gmap_has_website: 1, gmap_is_closed: 0, gmap_reviews_count_gte: brief.filters?.min_reviews ?? 10,
          credits: pull ? { spent: pull.spent, by_city_group: pull.tally } : null,
          excluded: excludedSummary,
        },
      };
  const { data: row, error } = await admin.from("maps_searches").insert({
    organization_id: ORG_ID, created_by: owner.id, query, results: places, result_count: places.length,
    target_max_results: places.length, truncated: false, saved_count: 0, status: "complete", actor: "scrapio",
    cost_usd: 0, // prepaid Scrap.io credits; the spend is in query.scrapio.credits
    progress_message: `Scrap.io pull, ${places.length} firms, imported by the tube-pipeline skill (run ${a.run})`,
    started_at: now, completed_at: now,
  }).select("id, saved_count, query").single();
  if (error || !row) throw error ?? new Error("maps_searches insert failed");
  console.log(`maps_searches row ${row.id}`);

  const imported = await importMapsPlaces(admin, { organizationId: ORG_ID, search: row, places });
  console.log(`imported ${imported.inserted} · skipped (already in Contacts) ${imported.skippedDuplicates} · set aside as weak email hosts ${imported.pooled}`);
  // Add the run's tags without dropping the ones import set (pooled-weak-host …).
  const rows = await getIn((l: string) => `contacts?select=id,tags,google_place_id&id=in.${l}`, imported.insertedIds, 100);
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const next = [...new Set([...(r.tags ?? []), ...tags, ...(placeTags.get(r.google_place_id) ?? [])])];
    const key = JSON.stringify(next);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r.id);
  }
  for (const [key, ids] of groups) {
    for (let i = 0; i < ids.length; i += 150) {
      const { error: tagErr } = await admin.from("contacts").update({ tags: JSON.parse(key) }).in("id", ids.slice(i, i + 150));
      if (tagErr) throw new Error(`tagging failed after import (contacts are in; tags partly set): ${tagErr.message}`);
    }
  }
  writeJson(prior, { at: new Date().toISOString(), search_id: row.id, ...imported });
  saveRun(dir, { cohort: { searches: [row.id], tag: null }, campaign_id: brief.campaign?.id ?? readRun(dir).campaign_id });
  stamp(dir, "source_import", { search_id: row.id, inserted: imported.inserted, skipped_duplicates: imported.skippedDuplicates, pooled: imported.pooled });
  console.log(`APPLIED. Next: enrich.mts --run ${a.run} (dry run first; it states the cost against the budget).`);
});
