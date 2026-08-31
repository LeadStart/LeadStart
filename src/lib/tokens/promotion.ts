import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { classifyContactOutcome, bestTier } from "@/lib/enrichment/outcomes";
import type { SearchKind } from "./pricing-math";
import { segmentForQuery } from "./segment";

// Phase 4 — master-pool PROMOTION. At settlement, a buyer search's delivered
// contacts are promoted into the shared, platform-owned `master_contacts` pool
// (deduped by natural key) and the buyer org is granted OWNERSHIP of each. The
// buyer keeps their per-org working copy (the `contacts` row); the master row is
// the resellable asset + the cross-buyer dedup index.
//
// Option A (owner-locked): the agency `contacts` table and the shared enrichment
// engine are UNTOUCHED — promotion is a purely additive read of the buyer's own
// delivered contacts plus a write to the two new pool tables, gated to buyer
// searches (those carrying a token hold — the same signal settleSearch uses).
//
// Two hard invariants (this runs inside enrichment completion):
//   1. It must NEVER throw to the caller — a promotion hiccup cannot break the
//      enrichment run (agency deliverability rides on that run finishing).
//   2. It must be idempotent — a search drains across multiple enrichment runs,
//      so the same contact is re-seen; ownership is granted once, and the master
//      merge only ever accretes (COALESCE, never clobber).

type Admin = ReturnType<typeof createAdminClient>;

// The buyer-`contacts` columns a master row is built from.
const PROMOTE_COLUMNS =
  "id, first_name, last_name, email, company_name, title, phone, company_phone, company_email, location, linkedin_url, company_linkedin_url, company_domain, google_place_id, enrichment_data, email_verification_status, email_verified_at";

interface PromotableContact {
  id: string;
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
}

/**
 * The stable, cross-buyer dedup key for a contact. Priority: the durable source
 * id (Maps place > LinkedIn url) before the mutable email fallback, so the same
 * real-world entity always resolves to one master row even as enrichment fills in
 * a personal email later. Returns null when a contact carries no keyable id
 * (skip — an unkeyable row can't be safely deduped into the shared pool).
 */
export function naturalKeyFor(c: {
  google_place_id: string | null;
  linkedin_url: string | null;
  email: string | null;
}): string | null {
  const place = c.google_place_id?.trim();
  if (place) return `place:${place}`;
  const li = c.linkedin_url?.trim().toLowerCase().replace(/\/+$/, "");
  if (li) return `li:${li}`;
  const email = c.email?.trim().toLowerCase();
  if (email) return `email:${email}`;
  return null;
}

// Best delivered tier for the master row's coverage/reporting column — recomputed
// from the contact's final columns (same classifier the run outcome ledger uses).
function bestTierFor(c: PromotableContact): string {
  const ed = (c.enrichment_data && typeof c.enrichment_data === "object" ? c.enrichment_data : {}) as Record<string, unknown>;
  const enr = (ed.enrichment && typeof ed.enrichment === "object" ? ed.enrichment : {}) as Record<string, unknown>;
  const emailBlock = (enr.email && typeof enr.email === "object" ? enr.email : {}) as Record<string, unknown>;
  const flags = classifyContactOutcome({
    email: c.email,
    emailVerificationStatus: c.email_verification_status,
    emailKind: typeof emailBlock.kind === "string" ? emailBlock.kind : null,
    emailProviderStatus: typeof emailBlock.provider_status === "string" ? emailBlock.provider_status : null,
    companyEmail: c.company_email,
    companyPhone: c.company_phone,
    phone: c.phone,
    firstName: c.first_name,
  });
  return bestTier(flags);
}

/** True unless the owner has turned promotion off in the singleton config. */
export async function isPromotionEnabled(admin: Admin): Promise<boolean> {
  try {
    const { data } = await admin
      .from("token_pricing_config")
      .select("master_pool_promotion_enabled")
      .eq("singleton", true)
      .maybeSingle();
    const c = data as { master_pool_promotion_enabled?: boolean | null } | null;
    // Default ON: absence of the row/flag means promotion runs (build the asset).
    return c?.master_pool_promotion_enabled !== false;
  } catch {
    return true;
  }
}

export interface PromotionResult {
  /** contacts examined (rows loaded for this search's run batch) */
  candidates: number;
  /** contacts that yielded a natural key and were upserted into the pool */
  promoted: number;
  /** ownership rows newly granted (not already owned by this buyer) */
  granted: number;
  /** the segment these grants were tagged with, or null if unsegmentable */
  segmentKey: string | null;
}

/**
 * Promote a buyer search's delivered contacts into the master pool + grant
 * ownership. Returns null for an agency search (no hold) — a true no-op. Never
 * throws: any failure is swallowed and logged so enrichment completion is safe.
 */
export async function promoteSearchContacts(
  admin: Admin,
  opts: { searchId: string; searchKind: SearchKind; contactIds: string[] },
): Promise<PromotionResult | null> {
  try {
    // Buyer gate: only searches carrying a hold are buyer searches. This is the
    // same signal settleSearch keys on, so agency searches are a clean no-op.
    const { data: holdRow } = await admin
      .from("token_ledger")
      .select("organization_id")
      .eq("search_id", opts.searchId)
      .eq("entry_type", "hold")
      .maybeSingle();
    const organizationId = (holdRow as { organization_id: string } | null)?.organization_id;
    if (!organizationId) return null; // agency search — nothing to promote

    if (opts.contactIds.length === 0) return { candidates: 0, promoted: 0, granted: 0, segmentKey: null };

    // Load the delivered rows for this run's batch (buyer-scoped, small — a buyer
    // search is capped at max_rows_per_search).
    const rows: PromotableContact[] = [];
    for (let i = 0; i < opts.contactIds.length; i += 300) {
      const part = opts.contactIds.slice(i, i + 300);
      const { data } = await admin
        .from("contacts")
        .select(PROMOTE_COLUMNS)
        .eq("organization_id", organizationId)
        .in("id", part);
      for (const r of (data as PromotableContact[] | null) ?? []) rows.push(r);
    }

    const payload = rows
      .map((c) => {
        const natural_key = naturalKeyFor(c);
        if (!natural_key) return null;
        return {
          natural_key,
          vein: opts.searchKind,
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
          company_name: c.company_name,
          title: c.title,
          phone: c.phone,
          company_phone: c.company_phone,
          company_email: c.company_email,
          location: c.location,
          linkedin_url: c.linkedin_url,
          company_linkedin_url: c.company_linkedin_url,
          company_domain: c.company_domain,
          google_place_id: c.google_place_id,
          enrichment_data: c.enrichment_data && typeof c.enrichment_data === "object" ? c.enrichment_data : {},
          email_verification_status: c.email_verification_status,
          email_verified_at: c.email_verified_at,
          best_tier: bestTierFor(c),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (payload.length === 0) return { candidates: rows.length, promoted: 0, granted: 0, segmentKey: null };

    // Resolve the search's SEGMENT (vein + simple terms + area) so the grants are
    // tagged for the coverage readout + cache. Unsegmentable searches (no terms or
    // no area) promote fine with a null segment.
    const table = opts.searchKind === "maps" ? "maps_searches" : "linkedin_searches";
    const { data: searchRow } = await admin.from(table).select("query").eq("id", opts.searchId).maybeSingle();
    const segment = segmentForQuery(opts.searchKind, (searchRow as { query?: unknown } | null)?.query);

    const { data: granted, error } = await admin.rpc("promote_master_contacts", {
      p_org: organizationId,
      p_search_id: opts.searchId,
      p_search_kind: opts.searchKind,
      p_segment_key: segment?.key ?? null,
      p_terms: segment?.terms ?? null,
      p_area: segment?.area ?? null,
      p_contacts: payload,
    });
    if (error) {
      console.error("[promoteSearchContacts] rpc failed for search", opts.searchId, error.message);
      return null;
    }
    return { candidates: rows.length, promoted: payload.length, granted: Number(granted ?? 0), segmentKey: segment?.key ?? null };
  } catch (e) {
    console.error("[promoteSearchContacts] failed for search", opts.searchId, e);
    return null;
  }
}
