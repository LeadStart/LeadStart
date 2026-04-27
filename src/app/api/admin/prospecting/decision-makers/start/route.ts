import { NextRequest, NextResponse } from "next/server";
import { requireDecisionMakerContext } from "@/lib/decision-maker/auth";
import type { ScrapioBusiness } from "@/types/app";

// POST /api/admin/prospecting/decision-makers/start
//
// Body: {
//   search_id: string,                // prospect_searches.id
//   google_ids: string[],             // selected business IDs
//   service_type?: 'operations' | 'events',
//   use_layer2?: boolean              // default true
// }
//
// Behavior:
// 1. Verify the search belongs to the caller's org and the requested
//    google_ids exist in its results JSONB.
// 2. Insert one decision_maker_runs row + one decision_maker_results row
//    per business. The cron worker (run-decision-maker-enrichment) picks
//    up the run on its next tick.
//
// Result reuse: the UNIQUE (search_id, google_id) index on
// decision_maker_results means re-enriching a business already done in a
// prior run will fail the insert. We pre-filter for that case so the new
// run only includes businesses without an existing complete result.

export const maxDuration = 10;

type Body = {
  search_id?: unknown;
  google_ids?: unknown;
  service_type?: unknown;
  use_layer2?: unknown;
};

export async function POST(request: NextRequest) {
  const ctx = await requireDecisionMakerContext();
  if ("error" in ctx) return ctx.error;
  const { user, organizationId, admin } = ctx;

  const body = (await request.json().catch(() => ({}))) as Body;

  const searchId = typeof body.search_id === "string" ? body.search_id : "";
  const googleIds = Array.isArray(body.google_ids)
    ? body.google_ids.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];
  const serviceType =
    body.service_type === "events" ? "events" : "operations";
  const useLayer2 = body.use_layer2 === undefined ? true : Boolean(body.use_layer2);

  if (!searchId || googleIds.length === 0) {
    return NextResponse.json(
      { error: "search_id and google_ids[] required" },
      { status: 400 },
    );
  }

  // Pull the search (RLS scopes to the caller's org via SELECT policy).
  const { data: searchRow, error: searchError } = await admin
    .from("prospect_searches")
    .select("id, organization_id, results")
    .eq("id", searchId)
    .maybeSingle();

  if (searchError) {
    return NextResponse.json({ error: searchError.message }, { status: 500 });
  }
  const search = searchRow as {
    id: string;
    organization_id: string;
    results: ScrapioBusiness[] | null;
  } | null;
  if (!search) {
    return NextResponse.json({ error: "Search not found" }, { status: 404 });
  }
  if (search.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Look up each requested google_id in the search's results JSONB. Build
  // the input rows for insert. Drop any IDs that don't exist in results.
  const wantedIds = new Set(googleIds);
  const businesses = (search.results ?? []).filter(
    (r) => r.google_id && wantedIds.has(r.google_id),
  );

  if (businesses.length === 0) {
    return NextResponse.json(
      { error: "No matching businesses found in this search" },
      { status: 400 },
    );
  }

  // Result reuse: any (search_id, google_id) pair that already has a
  // complete result row gets skipped — the worker won't re-enrich it.
  const { data: existing } = await admin
    .from("decision_maker_results")
    .select("google_id, status")
    .eq("search_id", searchId)
    .in("google_id", businesses.map((b) => b.google_id));

  const reused = new Set(
    ((existing as { google_id: string; status: string }[]) ?? [])
      .filter((r) => r.status === "complete")
      .map((r) => r.google_id),
  );

  const toEnrich = businesses.filter((b) => !reused.has(b.google_id));

  if (toEnrich.length === 0) {
    return NextResponse.json({
      error: "All selected businesses are already enriched in a prior run",
    }, { status: 400 });
  }

  // Create the parent run row.
  const { data: runRow, error: runError } = await admin
    .from("decision_maker_runs")
    .insert({
      organization_id: organizationId,
      created_by: user.id,
      search_id: searchId,
      service_type: serviceType,
      use_layer2: useLayer2,
      status: "pending",
      total_count: toEnrich.length,
      processed_count: 0,
      cost_usd: 0,
    })
    .select("id")
    .single();

  if (runError || !runRow) {
    console.error("[decision-makers/start] run insert failed:", runError);
    return NextResponse.json(
      { error: runError?.message ?? "Failed to create enrichment run" },
      { status: 500 },
    );
  }
  const runId = (runRow as { id: string }).id;

  // Bulk-insert the per-business result placeholders.
  const resultRows = toEnrich.map((b) => ({
    run_id: runId,
    organization_id: organizationId,
    search_id: searchId,
    google_id: b.google_id,
    business_name: b.name || null,
    category: b.types || null,
    status: "pending",
  }));

  const { error: resultsError } = await admin
    .from("decision_maker_results")
    .insert(resultRows);

  if (resultsError) {
    // Clean up the orphaned run row so the cron doesn't pick up a run
    // that has no work to do.
    await admin.from("decision_maker_runs").delete().eq("id", runId);
    console.error("[decision-makers/start] results insert failed:", resultsError);
    return NextResponse.json(
      { error: resultsError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    run_id: runId,
    total: toEnrich.length,
    reused: reused.size,
  });
}
