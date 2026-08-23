import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";

// GET /api/admin/prospecting/linkedin-searches/[id]
// Returns the search row for the polling UI. Mirrors enrich/run/[id].

export const maxDuration = 10;

const COLUMNS =
  "id, organization_id, query, results, result_count, target_max_results, truncated, saved_count, status, progress_message, error_message, actor, cost_usd, started_at, completed_at, expires_at, created_at";

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

  return NextResponse.json({ search: row });
}
