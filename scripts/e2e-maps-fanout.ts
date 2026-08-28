#!/usr/bin/env node
/**
 * Light e2e for the Maps multi-region FAN-OUT (Phase 2) against the LIVE DB, with
 * ZERO Apify spend and ZERO risk to prod's cron.
 *
 * SAFETY: prod's every-minute run-maps-searches cron grabs any pending/running
 * maps_searches row (any org) and starts a REAL paid actor run. So this test
 * NEVER parks a pending/running row — it inserts the throwaway search already
 * `complete` (prod ignores complete) and drives the two "areas" through the pure
 * ingest step with FAKE datasets, persisting each area's accumulation to the row
 * and reading it back. It proves what the unit tests can't: the multi-area
 * accumulation survives the JSONB round-trip and the ingest→dedupe→slice produces
 * the right final state, plus the per-area actor INPUT targets the two distinct
 * geographies with no locationQuery.
 *
 * MIGRATION-AWARE: the 00094 `area_index` column apply is Daniel's step (prod SQL
 * editor). This test PROBES for the column: if present, it also round-trips the
 * cursor; if absent, those two assertions are DEFERRED (reported, not failed) and
 * everything else runs. Cleans up the row it creates.
 *
 *   npx tsx scripts/e2e-maps-fanout.ts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  buildMapsSearchInputForArea,
  coerceMapsAreas,
  ingestAreaResult,
  perAreaMaxItems,
  type MapsArea,
} from "../src/lib/apify/sourcing/maps-search.ts";
import type { MapsPlace } from "../src/types/app.ts";

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}
const env = loadEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let pass = 0;
let fail = 0;
let deferred = 0;
function ok(cond: boolean, msg: string, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}
function defer(msg: string) {
  deferred++;
  console.log(`  ⚠ DEFERRED (needs migration 00094 applied): ${msg}`);
}

function place(id: string): MapsPlace {
  return {
    google_place_id: id, name: id, category: null, category_label: null, categories: [],
    website: null, company_domain: null, phone: null, full_address: null, street: null,
    city: null, state: null, postal_code: null, country_code: null, latitude: null,
    longitude: null, rating: null, reviews_count: null, maps_url: null,
    temporarily_closed: false, claimed: null,
  };
}
const ids = (rows: MapsPlace[] | null) => (rows ?? []).map((p) => p.google_place_id);

// Two distinct areas + a target of 3 (so per-area cap = ceil(3/2) = 2).
const AREAS: MapsArea[] = [
  { level: "city", name: "Dallas", state: "Texas", countryCode: "us", label: "Dallas, TX" },
  { level: "zip", postalCode: "10001", countryCode: "us", label: "10001" },
];
const TARGET = 3;

async function main() {
  const { data: prof, error: profErr } = await admin
    .from("profiles")
    .select("id, organization_id")
    .not("organization_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (profErr || !prof) {
    console.error("Could not find a profile to attribute the throwaway search to:", profErr);
    process.exit(1);
  }
  const orgId = (prof as { organization_id: string }).organization_id;
  const userId = (prof as { id: string }).id;
  console.log(`Using org ${orgId}, creator ${userId}`);

  // Probe whether 00094's area_index column exists yet (apply is Daniel's step).
  const { error: probeErr } = await admin.from("maps_searches").select("area_index").limit(1);
  const hasAreaIndex = !probeErr;
  console.log(hasAreaIndex ? "area_index column present → full round-trip" : "area_index column ABSENT → cursor assertions deferred");

  let searchId: string | null = null;
  try {
    // ── Per-area actor INPUT (no network) — the two runs the cron would start ──
    const perArea = perAreaMaxItems(TARGET, AREAS.length);
    ok(perArea === 2, "per-area cap = ceil(3/2) = 2", perArea);
    const in0 = buildMapsSearchInputForArea({ searchTerms: ["med spa"] }, AREAS[0], { maxItems: perArea });
    const in1 = buildMapsSearchInputForArea({ searchTerms: ["med spa"] }, AREAS[1], { maxItems: perArea });
    ok(in0.city === "Dallas" && in0.state === "Texas" && !("locationQuery" in in0), "area 0 input → Dallas/Texas structured, no locationQuery", in0);
    ok(in1.postalCode === "10001" && !("city" in in1) && !("locationQuery" in in1), "area 1 input → zip only, no city/locationQuery", in1);

    // ── Seed a COMPLETE throwaway row (prod's cron ignores complete) ──
    const seedRow: Record<string, unknown> = {
      organization_id: orgId,
      created_by: userId,
      query: { levers: { searchTerms: ["med spa"], areas: AREAS }, name: `E2E maps fan-out ${Date.now()}` },
      results: [],
      result_count: 0,
      target_max_results: TARGET,
      status: "complete", // NEVER pending/running — prod would start a paid run
      actor: "compass~google-maps-extractor",
    };
    if (hasAreaIndex) seedRow.area_index = 0;
    const { data: seeded, error: insErr } = await admin
      .from("maps_searches")
      .insert(seedRow)
      .select("id")
      .single();
    if (insErr) throw new Error(`seed insert: ${insErr.message}`);
    searchId = (seeded as { id: string }).id;
    if (hasAreaIndex) {
      const { data: ai } = await admin.from("maps_searches").select("area_index").eq("id", searchId).single();
      ok((ai as { area_index: number }).area_index === 0, "00094 area_index defaults 0 on insert");
    } else {
      defer("area_index defaults 0 on insert");
    }

    // Confirm the stored areas round-trip + coerce back to 2 valid areas.
    const { data: back0 } = await admin.from("maps_searches").select("query").eq("id", searchId).single();
    const storedAreas = coerceMapsAreas((back0 as { query: { levers?: { areas?: unknown } } }).query?.levers?.areas);
    ok(storedAreas.length === 2, "stored levers.areas round-trips → 2 coerced areas", storedAreas.length);

    // ── Area 0 finishes → accumulate, advance the cursor, persist ──
    const s0 = ingestAreaResult({ areaIndex: 0, areaCount: 2, accumulated: [], incoming: [place("a"), place("b")], target: TARGET });
    ok(!s0.done && s0.nextAreaIndex === 1, "area 0 ingest → not done, cursor → 1");
    const upd0: Record<string, unknown> = { results: s0.accumulated, result_count: s0.accumulated.length };
    if (hasAreaIndex) upd0.area_index = s0.nextAreaIndex;
    await admin.from("maps_searches").update(upd0).eq("id", searchId);
    const { data: mid } = await admin.from("maps_searches").select("results, result_count").eq("id", searchId).single();
    const midResults = (mid as { results: MapsPlace[] }).results;
    ok(JSON.stringify(ids(midResults)) === JSON.stringify(["a", "b"]), "partial accumulation [a,b] round-trips through JSONB", ids(midResults));
    if (hasAreaIndex) {
      const { data: c } = await admin.from("maps_searches").select("area_index").eq("id", searchId).single();
      ok((c as { area_index: number }).area_index === 1, "cursor persisted as 1 after area 0");
    } else {
      defer("cursor persisted as 1 after area 0");
    }

    // ── Area 1 finishes (overlapping + overflowing) → dedupe + slice to target ──
    const s1 = ingestAreaResult({ areaIndex: 1, areaCount: 2, accumulated: midResults, incoming: [place("b"), place("c"), place("d")], target: TARGET });
    ok(s1.done && s1.nextAreaIndex === 2, "area 1 ingest → done, cursor → 2");
    ok(JSON.stringify(ids(s1.finalResults ?? [])) === JSON.stringify(["a", "b", "c"]), "final union deduped (b once) + sliced to target 3", ids(s1.finalResults ?? []));
    ok(s1.truncated === true, "union (4) > target (3) → truncated");
    const upd1: Record<string, unknown> = { results: s1.finalResults, result_count: s1.finalResults!.length, truncated: Boolean(s1.truncated) };
    if (hasAreaIndex) upd1.area_index = s1.nextAreaIndex;
    await admin.from("maps_searches").update(upd1).eq("id", searchId);

    const { data: fin } = await admin.from("maps_searches").select("results, result_count, truncated, status").eq("id", searchId).single();
    const finRow = fin as { results: MapsPlace[]; result_count: number; truncated: boolean; status: string };
    ok(finRow.status === "complete", "row stayed complete throughout (never prod-grabbable)");
    ok(finRow.result_count === 3 && ids(finRow.results).join(",") === "a,b,c", "final results persisted: 3 deduped places", ids(finRow.results));
    ok(finRow.truncated === true, "truncated flag round-trips");
    if (hasAreaIndex) {
      const { data: c } = await admin.from("maps_searches").select("area_index").eq("id", searchId).single();
      ok((c as { area_index: number }).area_index === 2, "final cursor=2 round-trips");
    } else {
      defer("final cursor=2 round-trips");
    }
  } finally {
    console.log("\nCleaning up…");
    if (searchId) await admin.from("maps_searches").delete().eq("id", searchId);
    if (searchId) {
      const { count } = await admin.from("maps_searches").select("id", { count: "exact", head: true }).eq("id", searchId);
      ok((count ?? 0) === 0, "cleanup removed the throwaway search");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed${deferred ? `, ${deferred} deferred (migration 00094)` : ""}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
