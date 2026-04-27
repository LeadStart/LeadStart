import { NextRequest, NextResponse } from "next/server";
import { requireProspectingContext } from "@/lib/scrapio/auth";
import type { ScrapioBusiness } from "@/types/app";

// POST /api/admin/prospecting/save
//
// Body: { search_id: string, google_ids: string[] }
//
// Pulls the selected rows out of the cached prospect_searches.results,
// maps them onto the contacts table, and bulk-inserts. Saved contacts land
// in the existing Prospects/CRM Kanban under the Lead column with
// source='scrap.io'. Email-based dedup runs as a pre-flight check against
// the unique index from migration 00042.

type Body = {
  search_id?: unknown;
  google_ids?: unknown;
};

function pickFirst(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first || null;
}

export async function POST(request: NextRequest) {
  const ctx = await requireProspectingContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const body = (await request.json().catch(() => ({}))) as Body;
  const searchId = typeof body.search_id === "string" ? body.search_id : "";
  const googleIds = Array.isArray(body.google_ids)
    ? body.google_ids.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];

  if (!searchId || googleIds.length === 0) {
    return NextResponse.json(
      { error: "search_id and google_ids[] required" },
      { status: 400 },
    );
  }

  const { data: searchRow, error: fetchError } = await admin
    .from("prospect_searches")
    .select("id, organization_id, results, saved_count")
    .eq("id", searchId)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  const search = searchRow as
    | {
        id: string;
        organization_id: string;
        results: ScrapioBusiness[] | null;
        saved_count: number;
      }
    | null;
  if (!search) {
    return NextResponse.json({ error: "Search not found" }, { status: 404 });
  }
  if (search.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const wantedIds = new Set(googleIds);
  const candidates = (search.results ?? []).filter(
    (r) => r.google_id && wantedIds.has(r.google_id),
  );

  if (candidates.length === 0) {
    return NextResponse.json({
      requested: googleIds.length,
      inserted: 0,
      skipped_duplicates: 0,
      saved_google_ids: [],
      note: "No matching rows found in this search",
    });
  }

  // Pre-flight dedup. Two layers:
  // 1. In-batch: collapse duplicate emails within this save batch.
  // 2. Cross-batch: exclude rows whose lower(email) already exists in
  //    contacts for this org (matches the unique partial index from 00042).
  const seenEmails = new Set<string>();
  const candidatesByKey: Array<{
    row: ScrapioBusiness;
    emailKey: string | null;
  }> = [];
  for (const r of candidates) {
    const firstEmail = pickFirst(r.email);
    const lowered = firstEmail?.toLowerCase() ?? null;
    if (lowered && seenEmails.has(lowered)) continue;
    if (lowered) seenEmails.add(lowered);
    candidatesByKey.push({ row: r, emailKey: lowered });
  }

  const emailKeys = candidatesByKey
    .map((c) => c.emailKey)
    .filter((e): e is string => e !== null);

  let alreadyInDb = new Set<string>();
  if (emailKeys.length > 0) {
    const { data: existing } = await admin
      .from("contacts")
      .select("email")
      .eq("organization_id", organizationId)
      .in("email", emailKeys);
    alreadyInDb = new Set(
      ((existing as { email: string | null }[]) ?? [])
        .map((c) => c.email?.toLowerCase())
        .filter((e): e is string => Boolean(e)),
    );
  }

  const inBatchDuplicates = candidates.length - candidatesByKey.length;
  const crossBatchDuplicates = candidatesByKey.filter(
    (c) => c.emailKey && alreadyInDb.has(c.emailKey),
  ).length;

  const toInsert = candidatesByKey
    .filter((c) => !c.emailKey || !alreadyInDb.has(c.emailKey))
    .map(({ row, emailKey }) => {
      const now = new Date().toISOString();
      return {
        organization_id: organizationId,
        client_id: null,
        campaign_id: null,
        first_name: null,
        last_name: null,
        email: emailKey,
        company_name: row.name || null,
        title: null,
        phone: row.phone || null,
        linkedin_url: pickFirst(row.linkedin),
        intro_line: null,
        enrichment_data: row,
        tags: ["scrap.io"],
        status: "new",
        source: "scrap.io",
        notes: null,
        pipeline_stage: "lead",
        pipeline_sort_order: 0,
        pipeline_added_at: now,
        created_at: now,
        updated_at: now,
      };
    });

  if (toInsert.length === 0) {
    return NextResponse.json({
      requested: googleIds.length,
      inserted: 0,
      skipped_duplicates: inBatchDuplicates + crossBatchDuplicates,
      saved_google_ids: [],
    });
  }

  const { data: insertedRows, error: insertError } = await admin
    .from("contacts")
    .insert(toInsert)
    .select("id, enrichment_data");

  if (insertError) {
    console.error("[admin/prospecting/save] insert failed:", insertError);
    return NextResponse.json(
      { error: insertError.message },
      { status: 500 },
    );
  }

  const inserted = (insertedRows as { enrichment_data: ScrapioBusiness }[]) ?? [];
  const insertedCount = inserted.length;
  const savedGoogleIds = inserted
    .map((r) => r.enrichment_data?.google_id)
    .filter((id): id is string => Boolean(id));

  await admin
    .from("prospect_searches")
    .update({ saved_count: search.saved_count + insertedCount })
    .eq("id", search.id);

  return NextResponse.json({
    requested: googleIds.length,
    inserted: insertedCount,
    skipped_duplicates: inBatchDuplicates + crossBatchDuplicates,
    saved_google_ids: savedGoogleIds,
  });
}
