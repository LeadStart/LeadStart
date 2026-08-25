import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import type { LinkedInProspect } from "@/types/app";
import { enqueueEnrichment, type EnqueueResult } from "@/lib/apify/enqueue-enrichment";
import { importLinkedInProspects, type ImportSearchRow } from "@/lib/apify/import-prospects";

// POST /api/admin/prospecting/linkedin-save
//
// Body: { search_id, linkedin_urls: string[], campaign_id?: string }
//
// The manual Prospecting → Contacts handoff. Saves the chosen sourced people
// into contacts (deduped by lower(linkedin_url)/lower(email)) via the shared
// importLinkedInProspects helper — the same helper the auto-import path
// (run-linkedin-searches) uses — then auto-enqueues enrichment. When campaign_id
// is given, newly-inserted contacts are assigned to that campaign.

export const maxDuration = 30;

function lc(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

type Body = { search_id?: unknown; linkedin_urls?: unknown; campaign_id?: unknown };

export async function POST(request: NextRequest) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { user, organizationId, admin } = ctx;

  const body = (await request.json().catch(() => ({}))) as Body;
  const searchId = typeof body.search_id === "string" ? body.search_id : "";
  const wantUrls = Array.isArray(body.linkedin_urls)
    ? new Set(
        body.linkedin_urls.filter((v): v is string => typeof v === "string").map(lc),
      )
    : new Set<string>();
  const campaignId =
    typeof body.campaign_id === "string" && body.campaign_id ? body.campaign_id : null;

  if (!searchId) return NextResponse.json({ error: "search_id is required" }, { status: 400 });
  if (wantUrls.size === 0) {
    return NextResponse.json({ error: "Select at least one person" }, { status: 400 });
  }

  const { data: searchRow, error: searchErr } = await admin
    .from("linkedin_searches")
    .select("id, organization_id, results, saved_count, query")
    .eq("id", searchId)
    .maybeSingle();
  if (searchErr) return NextResponse.json({ error: searchErr.message }, { status: 500 });
  if (!searchRow) return NextResponse.json({ error: "Search not found" }, { status: 404 });
  if ((searchRow as { organization_id: string }).organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // If a campaign is targeted, confirm it belongs to the org and resolve its
  // client — a campaign-attributed import is that client's recipient list row,
  // so it must carry the client's id to show under Contacts → Client.
  let campaignClientId: string | null = null;
  if (campaignId) {
    const { data: camp } = await admin
      .from("campaigns")
      .select("id, client_id")
      .eq("id", campaignId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!camp) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    campaignClientId = (camp as { client_id: string | null }).client_id;
  }

  // The chosen subset of this search's cached prospects.
  const chosen = ((searchRow as { results: LinkedInProspect[] | null }).results ?? []).filter(
    (p) => p.linkedin_url && wantUrls.has(lc(p.linkedin_url)),
  );

  let result: { inserted: number; insertedIds: string[]; skippedDuplicates: number };
  try {
    result = await importLinkedInProspects(admin, {
      organizationId,
      search: searchRow as ImportSearchRow,
      prospects: chosen,
      campaignId,
      campaignClientId,
    });
  } catch (err) {
    console.error("[linkedin-save] import failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Import failed" },
      { status: 500 },
    );
  }

  // Auto-enrich the freshly imported people. Queue-behind: if a run is already
  // active for the org, they're stamped enrich_queued_at and the drain cron
  // starts them once the org frees. The activity/verify add-ons are read from
  // the enrichment_data stamped by the import.
  let enrichment: EnqueueResult = { status: "skipped", reason: "no_contacts" };
  if (result.insertedIds.length) {
    enrichment = await enqueueEnrichment(admin, {
      organizationId,
      userId: user.id,
      contactIds: result.insertedIds,
    });
  }

  return NextResponse.json({
    requested: wantUrls.size,
    inserted: result.inserted,
    skipped_duplicates: result.skippedDuplicates,
    campaign_id: campaignId,
    enrichment,
  });
}
