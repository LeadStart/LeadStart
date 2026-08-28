import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import { ApifyClient } from "@/lib/apify/client";
import { mergeMapsPlaces, parseMapsSearchResults } from "@/lib/apify/sourcing/maps-search";
import type { MapsPlace } from "@/types/app";

// GET /api/admin/prospecting/maps-searches/[id]
// Returns the search row for the polling UI. While a run is in flight, overlays
// LIVE data read straight from Apify (dataset item count + a capped page of
// parsed rows) so the results table streams places in as the actor scrapes them.
// Read-only + best-effort: persistence stays with the cron. The Google-Maps twin
// of the linkedin-searches/[id] route.

export const maxDuration = 10;

const STREAM_ROW_CAP = 300;

const COLUMNS =
  "id, organization_id, query, results, result_count, target_max_results, truncated, saved_count, status, progress_message, error_message, actor, cost_usd, delivered_counts, started_at, completed_at, expires_at, created_at, active_apify_dataset_id";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { data: row, error } = await admin
    .from("maps_searches")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Search not found" }, { status: 404 });
  if ((row as unknown as { organization_id: string }).organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const search = row as unknown as {
    status: string;
    results: MapsPlace[] | null;
    result_count: number | null;
    target_max_results: number | null;
    progress_message: string | null;
    active_apify_dataset_id: string | null;
  };

  if (search.status === "running" && search.active_apify_dataset_id && ctx.apifyToken) {
    const client = new ApifyClient(ctx.apifyToken);
    const dsId = search.active_apify_dataset_id;
    const [live, items] = await Promise.all([
      client.getDatasetItemCount(dsId).catch(() => null),
      client
        .getAllDatasetItems(dsId, { maxItems: STREAM_ROW_CAP })
        .catch(() => [] as Record<string, unknown>[]),
    ]);
    // The persisted `results` hold the de-duplicated union from ALREADY-finished
    // areas (empty for a single-area search); `active_apify_dataset_id` is the
    // CURRENT area's live dataset. Overlay = accumulated ∪ current area so the
    // streaming table shows the growing total, not just the current area.
    const accumulated = Array.isArray(search.results) ? search.results : [];
    if (typeof live === "number") {
      const target = search.target_max_results ?? live;
      const soFar = Math.max(search.result_count ?? 0, Math.min(accumulated.length + live, target));
      search.result_count = soFar;
      if (soFar > 0) search.progress_message = `Finding businesses… ${soFar} found`;
    }
    if (items.length > 0) {
      search.results = mergeMapsPlaces(accumulated, parseMapsSearchResults(items));
    }
  }

  return NextResponse.json({ search });
}

// PATCH /api/admin/prospecting/maps-searches/[id] — rename. The custom name lives
// on the `query` JSONB as `query.name`; an empty name clears it (UI falls back to
// the auto summary). Mirrors the linkedin-searches PATCH.
const MAX_NAME = 80;

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = (typeof body.name === "string" ? body.name : "").trim().slice(0, MAX_NAME);

  const { data: row, error: readErr } = await admin
    .from("maps_searches")
    .select("organization_id, query")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Search not found" }, { status: 404 });
  if ((row as { organization_id: string }).organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const query = ((row as { query: Record<string, unknown> | null }).query &&
  typeof (row as { query: unknown }).query === "object"
    ? (row as { query: Record<string, unknown> }).query
    : {}) as Record<string, unknown>;
  const nextQuery: Record<string, unknown> = { ...query };
  if (name) nextQuery.name = name;
  else delete nextQuery.name;

  const { error: updErr } = await admin.from("maps_searches").update({ query: nextQuery }).eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, name: name || null });
}
