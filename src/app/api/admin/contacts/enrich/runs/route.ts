import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import { ENRICH_RUN_COLUMNS } from "@/lib/apify/columns";

// GET /api/admin/contacts/enrich/runs
// Lists the org's last 20 enrichment runs + the currently active one (if any).
// The contacts page calls this on mount to resume the run banner after a
// refresh.

export const maxDuration = 10;

export async function GET(_request: NextRequest) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const { data, error } = await admin
    .from("enrichment_runs")
    .select(ENRICH_RUN_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const runs = data ?? [];
  const active =
    (runs as unknown as { status: string }[]).find(
      (r) => r.status === "pending" || r.status === "running",
    ) ?? null;

  return NextResponse.json({ runs, active });
}
