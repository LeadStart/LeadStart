import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import { ApifyClient } from "@/lib/apify/client";
import { parseProfileSearchResults } from "@/lib/apify/sourcing/profile-search";
import type { LinkedInProspect } from "@/types/app";

// GET /api/admin/prospecting/linkedin-searches/[id]
// Returns the search row for the polling UI. Mirrors enrich/run/[id].
//
// While a sourcing run is in flight, the response overlays LIVE data read
// straight from Apify — both the dataset item count AND a capped page of the
// parsed rows themselves, so the results table streams profiles in as the
// actor scrapes them (Phase 1 live review). The UI polls this route every 3s,
// but the cron (the state machine + DB writer) only refreshes the row once a
// minute and only stores `results` on completion. The overlay is read-only
// and best-effort: persistence stays with the cron, and any Apify hiccup just
// falls back to the stored row.

export const maxDuration = 10;

// Cap the rows streamed mid-run so the 3s poll payload stays bounded. The full
// set (up to target) lands from the cron on completion; this is a live preview.
const STREAM_ROW_CAP = 300;

const COLUMNS =
  "id, organization_id, query, results, result_count, target_max_results, truncated, saved_count, status, progress_message, error_message, actor, cost_usd, started_at, completed_at, expires_at, created_at, active_apify_dataset_id";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { data: row, error } = await admin
    .from("linkedin_searches")
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
    results: LinkedInProspect[] | null;
    result_count: number | null;
    target_max_results: number | null;
    progress_message: string | null;
    active_apify_dataset_id: string | null;
  };

  if (search.status === "running" && search.active_apify_dataset_id && ctx.apifyToken) {
    const client = new ApifyClient(ctx.apifyToken);
    const dsId = search.active_apify_dataset_id;
    // Two cheap, unbilled dataset reads: the true count (may exceed the row
    // cap) drives the progress number; the capped item page streams live rows.
    const [live, items] = await Promise.all([
      client.getDatasetItemCount(dsId).catch(() => null),
      client
        .getAllDatasetItems(dsId, { maxItems: STREAM_ROW_CAP })
        .catch(() => [] as Record<string, unknown>[]),
    ]);
    if (typeof live === "number") {
      const target = search.target_max_results ?? live;
      const soFar = Math.max(search.result_count ?? 0, Math.min(live, target));
      search.result_count = soFar;
      if (soFar > 0) search.progress_message = `Sourcing profiles… ${soFar} found`;
    }
    if (items.length > 0) {
      // Parse/dedup identically to the final ingest so streamed rows match the
      // completed set (same identity keys, same shape).
      search.results = parseProfileSearchResults(items);
    }
  }

  return NextResponse.json({ search });
}

// PATCH /api/admin/prospecting/linkedin-searches/[id]
// Renames a search. The custom name lives on the `query` JSONB (which nothing
// else mutates after creation) as `query.name`, so no schema change is needed;
// an empty name clears it and the UI falls back to the auto ICP summary.
const MAX_NAME = 80;

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = (typeof body.name === "string" ? body.name : "").trim().slice(0, MAX_NAME);

  const { data: row, error: readErr } = await admin
    .from("linkedin_searches")
    .select("organization_id, query")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Search not found" }, { status: 404 });
  if ((row as { organization_id: string }).organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const query =
    ((row as { query: Record<string, unknown> | null }).query &&
    typeof (row as { query: unknown }).query === "object"
      ? (row as { query: Record<string, unknown> }).query
      : {}) as Record<string, unknown>;
  const nextQuery: Record<string, unknown> = { ...query };
  if (name) nextQuery.name = name;
  else delete nextQuery.name; // clearing reverts to the auto summary

  const { error: updErr } = await admin
    .from("linkedin_searches")
    .update({ query: nextQuery })
    .eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, name: name || null });
}
