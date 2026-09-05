import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import type { MapsPlace } from "@/types/app";
import { enqueueEnrichment, type EnqueueResult } from "@/lib/apify/enqueue-enrichment";
import { importMapsPlaces, type ImportMapsSearchRow } from "@/lib/apify/import-maps-places";

// POST /api/admin/prospecting/maps-save
//
// Body: { search_id, google_place_ids: string[], campaign_id?: string }
//
// The manual Prospecting → Contacts handoff for the Maps vein. Saves the chosen
// places into contacts (deduped by google_place_id) via importMapsPlaces: the
// same helper the auto-import path uses: then auto-enqueues enrichment. The
// Google-Maps twin of linkedin-save.

export const maxDuration = 30;

type Body = { search_id?: unknown; google_place_ids?: unknown; campaign_id?: unknown };

export async function POST(request: NextRequest) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { user, organizationId, admin } = ctx;

  const body = (await request.json().catch(() => ({}))) as Body;
  const searchId = typeof body.search_id === "string" ? body.search_id : "";
  const wantIds = Array.isArray(body.google_place_ids)
    ? new Set(body.google_place_ids.filter((v): v is string => typeof v === "string"))
    : new Set<string>();
  const campaignId =
    typeof body.campaign_id === "string" && body.campaign_id ? body.campaign_id : null;

  if (!searchId) return NextResponse.json({ error: "search_id is required" }, { status: 400 });
  if (wantIds.size === 0) {
    return NextResponse.json({ error: "Select at least one business" }, { status: 400 });
  }

  const { data: searchRow, error: searchErr } = await admin
    .from("maps_searches")
    .select("id, organization_id, results, saved_count, query")
    .eq("id", searchId)
    .maybeSingle();
  if (searchErr) return NextResponse.json({ error: searchErr.message }, { status: 500 });
  if (!searchRow) return NextResponse.json({ error: "Search not found" }, { status: 404 });
  if ((searchRow as { organization_id: string }).organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Resolve the campaign's client (a campaign-attributed import is that client's
  // recipient row).
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

  const chosen = ((searchRow as { results: MapsPlace[] | null }).results ?? []).filter(
    (p) => p.google_place_id && wantIds.has(p.google_place_id),
  );

  let result: { inserted: number; insertedIds: string[]; skippedDuplicates: number };
  try {
    result = await importMapsPlaces(admin, {
      organizationId,
      search: searchRow as ImportMapsSearchRow,
      places: chosen,
      campaignId,
      campaignClientId,
    });
  } catch (err) {
    console.error("[maps-save] import failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Import failed" },
      { status: 500 },
    );
  }

  // Auto-enrich the freshly imported businesses (queue-behind if a run is active).
  let enrichment: EnqueueResult = { status: "skipped", reason: "no_contacts" };
  if (result.insertedIds.length) {
    enrichment = await enqueueEnrichment(admin, {
      organizationId,
      userId: user.id,
      contactIds: result.insertedIds,
    });
  }

  return NextResponse.json({
    requested: wantIds.size,
    inserted: result.inserted,
    skipped_duplicates: result.skippedDuplicates,
    campaign_id: campaignId,
    enrichment,
  });
}
