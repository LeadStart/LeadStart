import { NextRequest, NextResponse } from "next/server";
import { requireDecisionMakerContext } from "@/lib/decision-maker/auth";

// GET /api/admin/prospecting/decision-makers/run/[id]
//
// Returns the parent run row + all per-business result rows. The
// Prospecting page polls this every 3s while a run is active so the
// inline Decision Maker column can fill in progressively.

export const maxDuration = 10;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await requireDecisionMakerContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const { data: runRow, error: runError } = await admin
    .from("decision_maker_runs")
    .select(
      "id, organization_id, search_id, service_type, use_layer2, status, total_count, processed_count, cost_usd, started_at, completed_at, progress_message, error_message, created_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (runError) {
    return NextResponse.json({ error: runError.message }, { status: 500 });
  }
  if (!runRow) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = runRow as { organization_id: string };
  if (run.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: results, error: resultsError } = await admin
    .from("decision_maker_results")
    .select(
      "id, google_id, business_name, first_name, last_name, title, personal_email, other_emails, enrichment_source, enrichment_notes, status, cost_usd, updated_at",
    )
    .eq("run_id", id)
    .order("created_at", { ascending: true });

  if (resultsError) {
    return NextResponse.json(
      { error: resultsError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ run: runRow, results: results ?? [] });
}
