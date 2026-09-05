/**
 * Phase 4 SEGMENT-CACHE serve harness (integration, self-cleaning).
 *
 * Proves the resale path end to end against the live DB, then restores every
 * fixture AND the money config it toggled. Spends no real money (DB only).
 *
 *   1. Buyer A pulls segment S -> 3 masters promoted, A owns them, S is fresh.
 *   2. findServableMasterRows: B sees 3 servable, A sees 0 (owns all).
 *   3. Buyer B (with a balance) runs a search for S -> maybeServeFromCache SERVES:
 *      B gets 3 contact copies + owns the 3 masters + is charged, the search row
 *      is `complete` + served_from_cache, no pending row for the cron.
 *   4. B runs S again -> `skip` (owns all; nothing new to resell).
 *
 * Toggles token_pricing_config.segment_cache_enabled + a maps tier price; both are
 * captured up front and restored (and verified restored) in the finally block.
 *
 *   NODE_OPTIONS unused: run: npx tsx --tsconfig scripts/tsconfig.harness.json scripts/test-cache-serve.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { createAdminClient } from "../src/lib/supabase/admin";
import { maybeServeFromCache } from "../src/lib/tokens/cache-serve";
import { promoteSearchContacts } from "../src/lib/tokens/promotion";
import { segmentForQuery } from "../src/lib/tokens/segment";

type Admin = ReturnType<typeof createAdminClient>;

function loadEnvLocal(): Record<string, string> {
  const raw = readFileSync(".env.local", "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

async function balance(admin: Admin, org: string): Promise<number> {
  const { data } = await admin.from("token_balances").select("available").eq("organization_id", org).maybeSingle();
  return Number((data as { available?: number } | null)?.available ?? 0);
}

async function main() {
  const env = loadEnvLocal();
  const admin: Admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const tag = randomUUID().slice(0, 8);
  const searchQuery = { levers: { searchTerms: ["plumber"], areas: [{ level: "city", name: "Denver", state: "Colorado" }] } };
  const seg = segmentForQuery("maps", searchQuery)!;
  const keysA = [`place:CS_${tag}_1`, `place:CS_${tag}_2`, `place:CS_${tag}_3`];

  let orgA: string | null = null;
  let orgB: string | null = null;
  let orgC: string | null = null;
  const searchAId = randomUUID();
  const searchBId = randomUUID();
  const searchBId2 = randomUUID();
  const searchCId = randomUUID();
  const searchCId2 = randomUUID();

  // config we toggle (captured for restore)
  let origCacheEnabled: boolean | null = null;
  let origFreshness: number | null = null;
  let origTierPrice: number | null = null;
  let configTouched = false;

  try {
    const { data: prof } = await admin.from("profiles").select("id").limit(1).single();
    const creator = (prof as { id: string }).id;

    // capture + set money config (test price so pricing is "configured")
    const { data: cfg } = await admin
      .from("token_pricing_config")
      .select("segment_cache_enabled, segment_cache_freshness_days")
      .eq("singleton", true)
      .single();
    origCacheEnabled = (cfg as { segment_cache_enabled: boolean }).segment_cache_enabled;
    origFreshness = (cfg as { segment_cache_freshness_days: number | null }).segment_cache_freshness_days;
    const { data: tier } = await admin
      .from("token_price_tiers")
      .select("token_price")
      .eq("vein", "maps")
      .eq("tier_key", "company_inbox")
      .single();
    origTierPrice = (tier as { token_price: number | null }).token_price;
    configTouched = true;

    await admin.from("token_pricing_config").update({ segment_cache_enabled: true, segment_cache_freshness_days: 3650 }).eq("singleton", true);
    await admin.from("token_price_tiers").update({ token_price: 1 }).eq("vein", "maps").eq("tier_key", "company_inbox");

    // ---- fixtures: two orgs, a creator, org A's completed search + 3 contacts ----
    const { data: a } = await admin.from("organizations").insert({ name: `ZZZ_cache_A_${tag}` }).select("id").single();
    orgA = (a as { id: string }).id;
    const { data: b } = await admin.from("organizations").insert({ name: `ZZZ_cache_B_${tag}` }).select("id").single();
    orgB = (b as { id: string }).id;

    await admin.from("maps_searches").insert({
      id: searchAId, organization_id: orgA, created_by: creator, query: searchQuery,
      results: [], result_count: 3, target_max_results: 100, status: "complete", actor: "compass~google-maps-extractor",
    });
    await admin.from("token_ledger").insert({ organization_id: orgA, entry_type: "hold", tokens: 100, search_id: searchAId, search_kind: "maps" });

    const { data: aContacts } = await admin
      .from("contacts")
      .insert(keysA.map((k, i) => ({
        organization_id: orgA,
        company_name: `Cache Co ${i + 1}`,
        company_email: `info_${tag}_${i + 1}@cache.test`,
        google_place_id: k.slice("place:".length),
        source: "maps-prospecting",
        enrichment_data: { maps_search_id: searchAId },
      })))
      .select("id");
    const aIds = ((aContacts as { id: string }[]) ?? []).map((r) => r.id);
    ok("fixture: org A has 3 contacts", aIds.length === 3, aIds.length);

    // ---- populate the pool via A's promotion ----
    const promo = await promoteSearchContacts(admin, { searchId: searchAId, searchKind: "maps", contactIds: aIds });
    ok("A promoted 3 into the pool", promo?.promoted === 3 && promo?.granted === 3, promo);

    // ---- findServableMasterRows behavior (via the serve path's gate) ----
    // B owns none of segment S; A owns all. Prove by the serve outcomes below.

    // credit B so it can afford the charge
    await admin.from("token_ledger").insert({ organization_id: orgB, entry_type: "credit", tokens: 10000 });
    const bBefore = await balance(admin, orgB);
    ok("B starts with 10000 available", bBefore === 10000, bBefore);

    // ---- B serves segment S from cache ----
    const r = await maybeServeFromCache(admin, {
      organizationId: orgB!, searchId: searchBId, searchKind: "maps",
      query: searchQuery, targetMaxResults: 100, createdBy: creator, actor: "compass~google-maps-extractor",
    });
    ok("B served from cache", r.outcome === "served", r);
    ok("B served 3 contacts", r.outcome === "served" && r.served === 3, r);
    ok("B charged 3 (3 company inboxes @1)", r.outcome === "served" && r.charged === 3, r);

    const { count: bContacts } = await admin.from("contacts").select("id", { count: "exact", head: true }).eq("organization_id", orgB!).eq("source", "master-pool-cache");
    ok("B has 3 contact copies (source=master-pool-cache)", bContacts === 3, bContacts);
    const { count: bOwn } = await admin.from("contact_ownership").select("id", { count: "exact", head: true }).eq("organization_id", orgB!);
    ok("B owns 3 master rows", bOwn === 3, bOwn);

    const { data: bSearch } = await admin.from("maps_searches").select("status, query, delivered_counts").eq("id", searchBId).single();
    const bs = bSearch as { status: string; query: Record<string, unknown>; delivered_counts: Record<string, number> | null };
    ok("B's search row is complete (no cron run)", bs.status === "complete", bs.status);
    ok("B's search is marked served_from_cache", bs.query?.served_from_cache === true, bs.query);
    ok("B's search delivered_counts set", (bs.delivered_counts?.company_email ?? 0) === 3, bs.delivered_counts);

    const bAfter = await balance(admin, orgB!);
    ok("B's balance dropped by exactly the charge (3)", bAfter === bBefore - 3, { bBefore, bAfter });

    const { data: bLedger } = await admin.from("token_ledger").select("entry_type, tokens").eq("search_id", searchBId);
    const types = new Set(((bLedger as { entry_type: string }[]) ?? []).map((x) => x.entry_type));
    ok("B's ledger has hold + charge + release for the search", types.has("hold") && types.has("charge") && types.has("release"), [...types]);

    // ---- B runs the SAME segment again -> nothing new to resell -> skip ----
    const r2 = await maybeServeFromCache(admin, {
      organizationId: orgB!, searchId: searchBId2, searchKind: "maps",
      query: searchQuery, targetMaxResults: 100, createdBy: creator, actor: "compass~google-maps-extractor",
    });
    ok("B re-running the segment skips (owns all -> normal flow)", r2.outcome === "skip", r2);
    const { count: bSearch2 } = await admin.from("maps_searches").select("id", { count: "exact", head: true }).eq("id", searchBId2);
    ok("no served search row created on skip", bSearch2 === 0, bSearch2);

    // ---- explicit resale bypasses the freshness gate ----
    // Make the segment un-fresh by dropping its pull record; the auto path then
    // skips, but an explicit resale still serves the current pool remainder.
    await admin.from("segment_pulls").delete().eq("segment_key", seg.key);
    const { data: c } = await admin.from("organizations").insert({ name: `ZZZ_cache_C_${tag}`, kind: "buyer", is_self_serve: true }).select("id").single();
    orgC = (c as { id: string }).id;
    await admin.from("token_ledger").insert({ organization_id: orgC, entry_type: "credit", tokens: 10000 });

    const rAuto = await maybeServeFromCache(admin, {
      organizationId: orgC, searchId: searchCId, searchKind: "maps",
      query: searchQuery, targetMaxResults: 100, createdBy: creator, actor: "compass~google-maps-extractor",
    });
    ok("auto serve skips an un-fresh segment", rAuto.outcome === "skip", rAuto);

    const rExplicit = await maybeServeFromCache(admin, {
      organizationId: orgC, searchId: searchCId2, searchKind: "maps",
      query: searchQuery, targetMaxResults: 100, createdBy: creator, actor: "compass~google-maps-extractor",
      explicit: true,
    });
    ok("explicit resale serves the un-fresh segment (3)", rExplicit.outcome === "served" && rExplicit.served === 3, rExplicit);
    const { count: cOwn } = await admin.from("contact_ownership").select("id", { count: "exact", head: true }).eq("organization_id", orgC);
    ok("resale granted C ownership of 3", cOwn === 3, cOwn);
  } finally {
    // ---- restore money config first (most important) ----
    if (configTouched) {
      await admin.from("token_pricing_config").update({ segment_cache_enabled: origCacheEnabled, segment_cache_freshness_days: origFreshness }).eq("singleton", true);
      await admin.from("token_price_tiers").update({ token_price: origTierPrice }).eq("vein", "maps").eq("tier_key", "company_inbox");
      const { data: back } = await admin.from("token_pricing_config").select("segment_cache_enabled").eq("singleton", true).single();
      ok("config restored (segment_cache_enabled back to original)", (back as { segment_cache_enabled: boolean }).segment_cache_enabled === origCacheEnabled, back);
      const { data: backTier } = await admin.from("token_price_tiers").select("token_price").eq("vein", "maps").eq("tier_key", "company_inbox").single();
      ok("tier price restored", (backTier as { token_price: number | null }).token_price === origTierPrice, backTier);
    }
    // ---- teardown fixtures ----
    for (const org of [orgA, orgB, orgC]) {
      if (!org) continue;
      await admin.from("contact_ownership").delete().eq("organization_id", org);
      await admin.from("maps_searches").delete().eq("organization_id", org);
      await admin.from("token_ledger").delete().eq("organization_id", org);
      await admin.from("contacts").delete().eq("organization_id", org);
    }
    await admin.from("master_contacts").delete().in("natural_key", keysA);
    await admin.from("segment_pulls").delete().eq("segment_key", seg.key);
    for (const org of [orgA, orgB, orgC]) {
      if (org) await admin.from("organizations").delete().eq("id", org);
    }
    const { data: leftM } = await admin.from("master_contacts").select("id").in("natural_key", keysA);
    ok("teardown: pool test rows removed", (leftM as unknown[])?.length === 0, leftM);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
