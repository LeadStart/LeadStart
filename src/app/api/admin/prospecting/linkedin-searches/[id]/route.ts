import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import { ApifyClient } from "@/lib/apify/client";

// GET /api/admin/prospecting/linkedin-searches/[id]
// Returns the search row for the polling UI. Mirrors enrich/run/[id].
//
// While a sourcing run is in flight, the response overlays a LIVE dataset
// item count read straight from Apify — the UI polls this route every 3s,
// but the cron (the state machine + DB writer) only refreshes the row once
// a minute. The overlay is read-only and best-effort: persistence stays with
// the cron, and any Apify hiccup just falls back to the stored row.

export const maxDuration = 10;

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
    result_count: number | null;
    target_max_results: number | null;
    progress_message: string | null;
    active_apify_dataset_id: string | null;
  };

  if (search.status === "running" && search.active_apify_dataset_id && ctx.apifyToken) {
    try {
      const live = await new ApifyClient(ctx.apifyToken).getDatasetItemCount(
        search.active_apify_dataset_id,
      );
      if (typeof live === "number") {
        const target = search.target_max_results ?? live;
        const soFar = Math.max(search.result_count ?? 0, Math.min(live, target));
        search.result_count = soFar;
        if (soFar > 0) search.progress_message = `Sourcing profiles… ${soFar} found`;
      }
    } catch {
      // best-effort — the persisted row is still a valid answer
    }
  }

  return NextResponse.json({ search });
}
