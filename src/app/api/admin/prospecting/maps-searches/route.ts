import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";

// GET /api/admin/prospecting/maps-searches
//
// Lists the org's recent Google Maps searches for the "Prior runs" section on the
// Prospecting panel. Strips the heavy `results` JSONB: clicking a run hits the
// [id] endpoint for full results. Mirrors the linkedin-searches list route.

export const maxDuration = 10;

const LIST_COLUMNS =
  "id, query, result_count, target_max_results, truncated, saved_count, status, " +
  "progress_message, error_message, cost_usd, delivered_counts, started_at, completed_at, created_at";

export async function GET(_request: NextRequest) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const { data, error } = await admin
    .from("maps_searches")
    .select(LIST_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ searches: data ?? [] });
}
