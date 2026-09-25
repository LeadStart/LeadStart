import type { SupabaseClient } from "@supabase/supabase-js";
import type { MapsPlace } from "@/types/app";
import { lookupMailHosts, isWeakMailHost } from "@/lib/enrichment/mail-host";
import { POOL_TAG, isPooled } from "@/lib/enrichment/pool";

// Shared Maps-place → contacts import. Used by BOTH the manual "Import to
// Contacts" click (maps-save) and the automatic post-search import
// (run-maps-searches, when auto_run_after_search is on). Dedupes by
// google_place_id against the org (idx_contacts_org_place_unique): a Maps place
// has no email, so the (org, lower(email)) unique index can't catch a repeat.
//
// It does NOT enqueue enrichment: the caller owns that so it can react to the
// EnqueueResult. Business-level data lands in the company_* columns (00076):
// contacts.email/phone stay reserved for a decision-maker (the naming add-on).

const CHUNK = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type ImportMapsSearchRow = {
  id: string;
  saved_count: number | null;
  query: { addons?: unknown } | null;
};

export interface ImportMapsResult {
  inserted: number;
  insertedIds: string[];
  skippedDuplicates: number;
  /** Of the inserted, how many were set aside in the weak-email-host pool. */
  pooled: number;
}

export async function importMapsPlaces(
  admin: SupabaseClient,
  opts: {
    organizationId: string;
    search: ImportMapsSearchRow;
    places: MapsPlace[];
    campaignId?: string | null;
    campaignClientId?: string | null;
  },
): Promise<ImportMapsResult> {
  const { organizationId, search, places } = opts;
  const campaignId = opts.campaignId ?? null;
  const campaignClientId = opts.campaignClientId ?? null;
  const addons = (search.query?.addons ?? {}) as Record<string, unknown>;

  // Dedupe within the batch by google_place_id.
  const byPlace = new Map<string, MapsPlace>();
  for (const p of places) {
    if (!p.google_place_id) continue;
    if (!byPlace.has(p.google_place_id)) byPlace.set(p.google_place_id, p);
  }
  const chosen = Array.from(byPlace.values());
  if (chosen.length === 0) return { inserted: 0, insertedIds: [], skippedDuplicates: 0, pooled: 0 };

  // Cross-batch dedupe against contacts already in the org.
  const existing = new Set<string>();
  const placeIds = chosen.map((p) => p.google_place_id);
  for (const part of chunk(placeIds, 300)) {
    const { data } = await admin
      .from("contacts")
      .select("google_place_id")
      .eq("organization_id", organizationId)
      .in("google_place_id", part);
    for (const r of (data as { google_place_id: string | null }[] | null) ?? []) {
      if (r.google_place_id) existing.add(r.google_place_id);
    }
  }

  const now = new Date().toISOString();
  const fresh = chosen.filter((p) => !existing.has(p.google_place_id));
  // Who runs each firm's email (free MX lookup), stamped at import. A firm on a
  // weak host (guesses rarely verify there) is set aside in the pool: tagged,
  // never enriched automatically, and NOT attached to the import's campaign even
  // when one was picked (lib/enrichment/pool). Address guessing is also skipped
  // where the domain has no mail server. Domains not answered inside the budget
  // stay unstamped and are checked (and pooled if weak) at enqueue.
  const domainKey = (d: string | null) => (d ?? "").trim().toLowerCase().replace(/^www\./, "");
  const mailHosts = await lookupMailHosts(
    fresh.map((p) => domainKey(p.company_domain)).filter(Boolean),
    { budgetMs: 8000 },
  );
  const toInsert = fresh
    .map((p) => ({ p, mailHost: mailHosts.get(domainKey(p.company_domain)) }))
    .map(({ p, mailHost }) => ({
      organization_id: organizationId,
      client_id: campaignClientId,
      campaign_id: isWeakMailHost(mailHost?.host) ? null : campaignId,
      first_name: null,
      last_name: null,
      email: null,
      company_name: p.name,
      // A Maps phone is the company line (00076): contacts.phone stays reserved
      // for a decision-maker's own number, filled later by the naming add-on.
      company_phone: p.phone,
      company_domain: p.company_domain,
      google_place_id: p.google_place_id,
      // Person location unknown; store the business city/state at the root so
      // extractContactLocation (domain-discovery + naming) has geo to work with.
      enrichment_data: {
        maps_search_id: search.id,
        addons,
        city: p.city,
        state: p.state,
        source_row: p,
        ...(mailHost ? { mail_host: mailHost } : {}),
      },
      tags: isWeakMailHost(mailHost?.host) ? ["maps", "prospecting", POOL_TAG] : ["maps", "prospecting"],
      status: "new",
      source: "maps-prospecting",
      pipeline_stage: campaignClientId ? null : "lead",
      pipeline_sort_order: 0,
      pipeline_added_at: campaignClientId ? null : now,
      created_at: now,
      updated_at: now,
    }));

  let inserted = 0;
  let pooled = 0;
  const insertedIds: string[] = [];
  const take = (rows: { id: string; tags: string[] | null }[]) => {
    inserted += rows.length;
    for (const r of rows) {
      insertedIds.push(r.id);
      if (isPooled(r.tags)) pooled++;
    }
  };
  for (const part of chunk(toInsert, CHUNK)) {
    const { data, error } = await admin.from("contacts").insert(part).select("id, tags");
    if (!error) {
      take((data as { id: string; tags: string[] | null }[] | null) ?? []);
      continue;
    }
    // A residual place-id collision (23505) must not sink the whole batch: retry
    // row-by-row and skip only the rows that conflict.
    if (error.code === "23505") {
      for (const one of part) {
        const { data: got, error: oneErr } = await admin.from("contacts").insert(one).select("id, tags");
        if (oneErr) {
          if (oneErr.code === "23505") continue;
          throw oneErr;
        }
        take((got as { id: string; tags: string[] | null }[] | null) ?? []);
      }
      continue;
    }
    throw error;
  }

  const prevSaved = search.saved_count ?? 0;
  await admin.from("maps_searches").update({ saved_count: prevSaved + inserted }).eq("id", search.id);

  return { inserted, insertedIds, skippedDuplicates: chosen.length - inserted, pooled };
}
