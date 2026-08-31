import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { classifyContactOutcome, addOutcome } from "@/lib/enrichment/outcomes";
import { loadPricingTiers, priceDelivered, placeHold, settleSearch } from "./billing";
import { promoteSearchContacts } from "./promotion";
import { segmentForQuery } from "./segment";
import type { SearchKind } from "./pricing-math";

// Phase 4 — SEGMENT CACHE serve (the resale path, ~100% margin). When a buyer
// starts a search whose segment (vein + terms + area) was pulled recently enough
// (within token_pricing_config.segment_cache_freshness_days), we serve the pool's
// matching contacts straight into the buyer's org — a copy in `contacts` + a
// promotion-granted ownership row + the SAME token charge — with NO actor run.
//
// Gated OFF by default (segment_cache_enabled=false) and behind a fresh-pull +
// balance check. The money path REUSES the proven billing primitives: placeHold
// (reserve + balance gate) → promoteSearchContacts (the buyer's copies become
// owned pool rows) → settleSearch (charge the delivered outcomes, release the
// rest). So a cache serve bills identically to a fresh pull, no resale discount
// (owner decision D3). Any failure or ineligibility yields `skip`, and the caller
// runs the normal sourcing flow — the cache never blocks a search.

type Admin = ReturnType<typeof createAdminClient>;

const MASTER_COLS =
  "id, natural_key, first_name, last_name, email, company_name, title, phone, company_phone, company_email, location, linkedin_url, company_linkedin_url, company_domain, google_place_id, enrichment_data, email_verification_status, email_verified_at, best_tier";

interface MasterRow {
  id: string;
  natural_key: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  title: string | null;
  phone: string | null;
  company_phone: string | null;
  company_email: string | null;
  location: string | null;
  linkedin_url: string | null;
  company_linkedin_url: string | null;
  company_domain: string | null;
  google_place_id: string | null;
  enrichment_data: unknown;
  email_verification_status: string | null;
  email_verified_at: string | null;
  best_tier: string | null;
}

export type CacheServeResult =
  | { outcome: "served"; served: number; charged: number }
  | { outcome: "skip" }
  | { outcome: "rejected"; reason: "insufficient_tokens" | "pricing_not_configured"; held?: number; available?: number };

async function loadCacheConfig(admin: Admin): Promise<{ enabled: boolean; freshnessDays: number | null }> {
  const { data } = await admin
    .from("token_pricing_config")
    .select("segment_cache_enabled, segment_cache_freshness_days")
    .eq("singleton", true)
    .maybeSingle();
  const c = data as { segment_cache_enabled?: boolean | null; segment_cache_freshness_days?: number | null } | null;
  return { enabled: c?.segment_cache_enabled === true, freshnessDays: c?.segment_cache_freshness_days ?? null };
}

// Master pool rows for this segment the buyer does NOT already own (any segment),
// capped at the search's target. Empty ⇒ nothing new to resell → normal flow.
async function findServableMasterRows(
  admin: Admin,
  organizationId: string,
  segmentKey: string,
  limit: number,
): Promise<MasterRow[]> {
  const { data: cand } = await admin.from("contact_ownership").select("master_contact_id").eq("segment_key", segmentKey);
  const candidateIds = Array.from(new Set(((cand as { master_contact_id: string }[] | null) ?? []).map((r) => r.master_contact_id)));
  if (candidateIds.length === 0) return [];

  const owned = new Set<string>();
  for (let i = 0; i < candidateIds.length; i += 300) {
    const part = candidateIds.slice(i, i + 300);
    const { data } = await admin
      .from("contact_ownership")
      .select("master_contact_id")
      .eq("organization_id", organizationId)
      .in("master_contact_id", part);
    for (const r of (data as { master_contact_id: string }[] | null) ?? []) owned.add(r.master_contact_id);
  }

  const servableIds = candidateIds.filter((id) => !owned.has(id)).slice(0, Math.max(0, limit));
  if (servableIds.length === 0) return [];

  const rows: MasterRow[] = [];
  for (let i = 0; i < servableIds.length; i += 300) {
    const part = servableIds.slice(i, i + 300);
    const { data } = await admin.from("master_contacts").select(MASTER_COLS).in("id", part);
    for (const r of (data as MasterRow[] | null) ?? []) rows.push(r);
  }
  return rows;
}

// Recompute a master row's delivered-outcome flags from its final columns (same
// classifier the run outcome ledger + promotion use), for the served-counts total.
function classifyMaster(m: MasterRow) {
  const ed = (m.enrichment_data && typeof m.enrichment_data === "object" ? m.enrichment_data : {}) as Record<string, unknown>;
  const enr = (ed.enrichment && typeof ed.enrichment === "object" ? ed.enrichment : {}) as Record<string, unknown>;
  const emailBlock = (enr.email && typeof enr.email === "object" ? enr.email : {}) as Record<string, unknown>;
  return classifyContactOutcome({
    email: m.email,
    emailVerificationStatus: m.email_verification_status,
    emailKind: typeof emailBlock.kind === "string" ? emailBlock.kind : null,
    emailProviderStatus: typeof emailBlock.provider_status === "string" ? emailBlock.provider_status : null,
    companyEmail: m.company_email,
    companyPhone: m.company_phone,
    phone: m.phone,
    firstName: m.first_name,
  });
}

// A master row → a buyer-org `contacts` insert (the buyer's working copy). Stamps
// the search linkage + a served-from-cache marker onto enrichment_data so the
// contact is attributable exactly like a freshly-sourced one.
function masterToContactInsert(
  m: MasterRow,
  organizationId: string,
  searchId: string,
  searchKind: SearchKind,
  now: string,
): Record<string, unknown> {
  const ed = (m.enrichment_data && typeof m.enrichment_data === "object" ? { ...(m.enrichment_data as Record<string, unknown>) } : {}) as Record<string, unknown>;
  ed[`${searchKind}_search_id`] = searchId;
  ed.served_from_cache = true;
  return {
    organization_id: organizationId,
    first_name: m.first_name,
    last_name: m.last_name,
    email: m.email,
    company_name: m.company_name,
    title: m.title,
    phone: m.phone,
    company_phone: m.company_phone,
    company_email: m.company_email,
    location: m.location,
    linkedin_url: m.linkedin_url,
    company_linkedin_url: m.company_linkedin_url,
    company_domain: m.company_domain,
    google_place_id: m.google_place_id,
    enrichment_data: ed,
    email_verification_status: m.email_verification_status,
    email_verified_at: m.email_verified_at,
    tags: [searchKind, "prospecting", "cache"],
    status: "new",
    source: "master-pool-cache",
    pipeline_stage: "lead",
    pipeline_sort_order: 0,
    pipeline_added_at: now,
    created_at: now,
    updated_at: now,
  };
}

// Insert the buyer's copies of the served rows, skipping any that collide with an
// existing org contact (the org-scoped unique indexes on email/place/linkedin).
async function insertServedContacts(
  admin: Admin,
  organizationId: string,
  searchId: string,
  searchKind: SearchKind,
  rows: MasterRow[],
): Promise<string[]> {
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (const m of rows) {
    const { data, error } = await admin
      .from("contacts")
      .insert(masterToContactInsert(m, organizationId, searchId, searchKind, now))
      .select("id");
    if (error) {
      if (error.code === "23505") continue; // already in the buyer's org — keep theirs
      throw error;
    }
    for (const r of (data as { id: string }[] | null) ?? []) ids.push(r.id);
  }
  return ids;
}

/**
 * Try to serve a buyer search from the segment cache. Returns `skip` (do the
 * normal sourcing flow) when the cache is disabled, the search can't be
 * segmented, the segment isn't fresh, or nothing new is available. `rejected`
 * when the buyer can't cover the charge. `served` when the pool delivered.
 *
 * On any error after the reservation, it rolls the hold back and returns `skip`
 * so the caller can still source normally with the same pre-generated searchId.
 */
export async function maybeServeFromCache(
  admin: Admin,
  opts: {
    organizationId: string;
    searchId: string;
    searchKind: SearchKind;
    query: Record<string, unknown>; // stored on the search row + drives the segment
    targetMaxResults: number;
    createdBy: string;
    actor: string;
  },
): Promise<CacheServeResult> {
  // ---- eligibility (no mutation) ----
  let servable: MasterRow[];
  try {
    const cfg = await loadCacheConfig(admin);
    if (!cfg.enabled) return { outcome: "skip" };

    const segment = segmentForQuery(opts.searchKind, opts.query);
    if (!segment) return { outcome: "skip" };

    const { data: sp } = await admin
      .from("segment_pulls")
      .select("last_pulled_at")
      .eq("segment_key", segment.key)
      .maybeSingle();
    const lastPulled = (sp as { last_pulled_at: string | null } | null)?.last_pulled_at;
    if (!lastPulled) return { outcome: "skip" };
    if (cfg.freshnessDays != null) {
      const ageDays = (Date.parse(new Date().toISOString()) - Date.parse(lastPulled)) / 86_400_000;
      if (ageDays > cfg.freshnessDays) return { outcome: "skip" };
    }

    servable = await findServableMasterRows(admin, opts.organizationId, segment.key, opts.targetMaxResults);
    if (servable.length === 0) return { outcome: "skip" };
  } catch (e) {
    console.error("[maybeServeFromCache] eligibility check failed:", e);
    return { outcome: "skip" };
  }

  // ---- reserve (balance gate) ----
  const hold = await placeHold(admin, {
    organizationId: opts.organizationId,
    searchId: opts.searchId,
    searchKind: opts.searchKind,
    targetMaxResults: servable.length,
  });
  if (!hold.ok) {
    if (hold.reason === "insufficient_tokens") return { outcome: "rejected", reason: "insufficient_tokens", held: hold.held, available: hold.available };
    if (hold.reason === "pricing_not_configured") return { outcome: "rejected", reason: "pricing_not_configured" };
    return { outcome: "skip" };
  }

  // ---- deliver (committed; roll the hold back on failure) ----
  const table = opts.searchKind === "maps" ? "maps_searches" : "linkedin_searches";
  const now = new Date().toISOString();
  try {
    const tiers = await loadPricingTiers(admin);
    const servedCounts: Record<string, number> = {};
    for (const m of servable) addOutcome(servedCounts, classifyMaster(m));

    const { error: sErr } = await admin.from(table).insert({
      id: opts.searchId,
      organization_id: opts.organizationId,
      created_by: opts.createdBy,
      query: { ...opts.query, served_from_cache: true },
      results: [],
      result_count: servable.length,
      saved_count: servable.length,
      target_max_results: opts.targetMaxResults,
      status: "complete",
      actor: opts.actor,
      delivered_counts: servedCounts,
      completed_at: now,
    });
    if (sErr) throw new Error(`search insert: ${sErr.message}`);

    const contactIds = await insertServedContacts(admin, opts.organizationId, opts.searchId, opts.searchKind, servable);

    // Grant ownership + refresh segment_pulls via the proven promotion path (it
    // gates on the hold we just placed + derives the segment from the search row).
    await promoteSearchContacts(admin, { searchId: opts.searchId, searchKind: opts.searchKind, contactIds });

    // Charge the delivered outcomes, release the rest (identical to a fresh pull).
    await settleSearch(admin, { searchId: opts.searchId, searchKind: opts.searchKind, deliveredCounts: servedCounts });

    const charged = Math.ceil(priceDelivered(tiers, opts.searchKind, servedCounts));
    return { outcome: "served", served: contactIds.length, charged };
  } catch (e) {
    console.error("[maybeServeFromCache] delivery failed, rolling back:", e);
    // Best-effort rollback so the buyer is neither charged nor left with a stub:
    // drop the hold (restores available), the served copies, the ownership grants,
    // and the search row — then let the caller source normally.
    await admin.from("token_ledger").delete().eq("search_id", opts.searchId).in("entry_type", ["hold", "charge", "release"]);
    await admin.from("contact_ownership").delete().eq("search_id", opts.searchId);
    await admin.from("contacts").delete().eq("organization_id", opts.organizationId).contains("enrichment_data", { [`${opts.searchKind}_search_id`]: opts.searchId, served_from_cache: true });
    await admin.from(table).delete().eq("id", opts.searchId);
    return { outcome: "skip" };
  }
}
