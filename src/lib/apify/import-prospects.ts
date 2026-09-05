import type { SupabaseClient } from "@supabase/supabase-js";
import type { LinkedInProspect } from "@/types/app";
import { normalizeAddons } from "./auth";

// One bare address, same shape the CSV importer enforces (client-import/route.ts).
const IMPORT_EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

// Shared LinkedIn-prospect → contacts import. Used by BOTH the manual "Import to
// Contacts" click (linkedin-save) and the automatic post-search import
// (run-linkedin-searches, when auto_run_after_search is on). Dedupes by
// lower(linkedin_url) and lower(email) against the org, inserts new contacts
// (stamping the search's activity/verify add-on choices onto enrichment_data so
// enqueueEnrichment can read them back), and bumps the search's saved_count.
//
// It does NOT enqueue enrichment — the caller owns that so it can react to the
// EnqueueResult. Already-existing (deduped) contacts are left untouched: like
// the original manual save, they are not re-assigned to a campaign.

const CHUNK = 200;

function lc(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// The slice of a linkedin_searches row the import needs.
export type ImportSearchRow = {
  id: string;
  saved_count: number | null;
  query: {
    levers?: { recentlyPostedOnLinkedIn?: boolean };
    addons?: unknown;
  } | null;
};

export interface ImportResult {
  inserted: number;
  insertedIds: string[];
  skippedDuplicates: number;
}

export async function importLinkedInProspects(
  admin: SupabaseClient,
  opts: {
    organizationId: string;
    search: ImportSearchRow;
    prospects: LinkedInProspect[];
    campaignId?: string | null;
    campaignClientId?: string | null;
  },
): Promise<ImportResult> {
  const { organizationId, search, prospects } = opts;
  const campaignId = opts.campaignId ?? null;
  const campaignClientId = opts.campaignClientId ?? null;

  // If the search filtered on "active on LinkedIn", the imported people are
  // known-active — stamp them so the activity add-on (if on) skips the redundant
  // pass. The per-search add-on choices ride the same enrichment_data blob.
  const skipActivity = search.query?.levers?.recentlyPostedOnLinkedIn === true;
  const addons = normalizeAddons(search.query?.addons);

  // Dedupe within the batch by lower(linkedin_url) (drops entries with no URL).
  const byUrl = new Map<string, LinkedInProspect>();
  for (const p of prospects) {
    if (!p.linkedin_url) continue;
    const k = lc(p.linkedin_url);
    if (k && !byUrl.has(k)) byUrl.set(k, p);
  }
  const chosen = Array.from(byUrl.values());
  if (chosen.length === 0) return { inserted: 0, insertedIds: [], skippedDuplicates: 0 };

  // Cross-batch dedupe against contacts already in the org (idx_contacts_org_linkedin).
  const existing = new Set<string>();
  const urlVariants = Array.from(
    new Set(chosen.flatMap((p) => [p.linkedin_url as string, (p.linkedin_url as string).toLowerCase()])),
  );
  for (const part of chunk(urlVariants, 300)) {
    const { data } = await admin
      .from("contacts")
      .select("linkedin_url")
      .eq("organization_id", organizationId)
      .in("linkedin_url", part);
    for (const r of (data as { linkedin_url: string | null }[] | null) ?? []) {
      if (r.linkedin_url) existing.add(lc(r.linkedin_url));
    }
  }

  // Also dedupe by email (idx_contacts_org_email_unique, on lower(email)). The
  // linkedin_url check alone let a single pre-existing email violate the unique
  // constraint and fail the WHOLE batch insert — saving nothing.
  const existingEmails = new Set<string>();
  const emailVariants = Array.from(
    new Set(
      chosen
        .map((p) => p.email)
        .filter((e): e is string => Boolean(e && e.trim()))
        .flatMap((e) => [e, e.toLowerCase()]),
    ),
  );
  for (const part of chunk(emailVariants, 300)) {
    const { data } = await admin
      .from("contacts")
      .select("email")
      .eq("organization_id", organizationId)
      .in("email", part);
    for (const r of (data as { email: string | null }[] | null) ?? []) {
      if (r.email) existingEmails.add(lc(r.email));
    }
  }

  const now = new Date().toISOString();
  const seenEmail = new Set<string>();
  const toInsert = chosen
    .filter((p) => {
      if (existing.has(lc(p.linkedin_url))) return false;
      const e = lc(p.email);
      if (e) {
        // Skip an email that's already in the org, or repeated within this batch.
        if (existingEmails.has(e) || seenEmail.has(e)) return false;
        seenEmail.add(e);
      }
      return true;
    })
    .map((p) => ({
      organization_id: organizationId,
      client_id: campaignClientId,
      campaign_id: campaignId,
      first_name: p.first_name,
      last_name: p.last_name,
      // Actor-supplied emails are validated at the sink like CSV emails are:
      // an unanchored value such as "a@x.com, b@x.com" reached the To: header
      // verbatim and became a two-recipient send (SEND_RUNTIME_AUDIT.md
      // SEND-33). Anything that is not one bare address is stored as no email.
      email: p.email && IMPORT_EMAIL_RE.test(p.email.trim()) ? p.email.trim().toLowerCase() : null,
      company_name: p.company_name,
      title: p.headline,
      // The PERSON's LinkedIn profile location (migration 00078) — where they
      // live/work, not the company's address.
      location: p.location,
      linkedin_url: p.linkedin_url,
      company_linkedin_url: p.company_linkedin_url,
      company_domain: p.company_domain,
      enrichment_data: {
        linkedin_search_id: search.id,
        skip_activity: skipActivity,
        addons,
        source_row: p,
      },
      tags: ["linkedin", "prospecting"],
      status: "new",
      source: "linkedin-prospecting",
      // Client-bound imports (campaign has a client) are recipient rows, not
      // agency prospects — they stay off the Prospects kanban, which is
      // client_id-IS-NULL-only.
      pipeline_stage: campaignClientId ? null : "lead",
      pipeline_sort_order: 0,
      pipeline_added_at: campaignClientId ? null : now,
      created_at: now,
      updated_at: now,
    }));

  let inserted = 0;
  const insertedIds: string[] = [];
  for (const part of chunk(toInsert, CHUNK)) {
    const { data, error } = await admin.from("contacts").insert(part).select("id");
    if (!error) {
      const ids = (data as { id: string }[] | null) ?? [];
      inserted += ids.length;
      for (const r of ids) insertedIds.push(r.id);
      continue;
    }
    // A residual unique-constraint collision (23505) must not sink the whole
    // batch — retry this chunk row-by-row and skip only the rows that conflict.
    if (error.code === "23505") {
      for (const oneRow of part) {
        const { data: one, error: oneErr } = await admin.from("contacts").insert(oneRow).select("id");
        if (oneErr) {
          if (oneErr.code === "23505") continue; // already exists — skip
          throw oneErr;
        }
        const ids = (one as { id: string }[] | null) ?? [];
        inserted += ids.length;
        for (const r of ids) insertedIds.push(r.id);
      }
      continue;
    }
    throw error;
  }

  const prevSaved = search.saved_count ?? 0;
  await admin
    .from("linkedin_searches")
    .update({ saved_count: prevSaved + inserted })
    .eq("id", search.id);

  return { inserted, insertedIds, skippedDuplicates: chosen.length - inserted };
}
