import { NextRequest, NextResponse } from "next/server";
import { requireDecisionMakerContext } from "@/lib/decision-maker/auth";

// GET /api/admin/prospecting/decision-makers/runs?search_id=<uuid>
//
// Lists recent enrichment runs for the org (last 20). Optional search_id
// filter scopes to one Scrap.io search. Used by the Prospecting page to
// surface "you've already enriched these businesses" state when a user
// reopens a search.

export const maxDuration = 10;

export async function GET(request: NextRequest) {
  const ctx = await requireDecisionMakerContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const searchId = request.nextUrl.searchParams.get("search_id");

  let query = admin
    .from("decision_maker_runs")
    .select(
      "id, search_id, service_type, use_layer2, status, total_count, processed_count, cost_usd, started_at, completed_at, progress_message, error_message, created_at",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (searchId) {
    query = query.eq("search_id", searchId);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ runs: data ?? [] });
}
