import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import { ENRICH_RUN_COLUMNS, ENRICH_ITEM_COLUMNS } from "@/lib/apify/columns";

// GET /api/admin/contacts/enrich/run/[id]
// Returns the parent run + all its items. The contacts page polls this every
// 3s while a run is active. Items are paged with .range() because PostgREST
// caps a select at 1,000 rows and a run can hold up to 2,000.

export const maxDuration = 10;

const PAGE = 1000;
const MAX_ITEMS = 5000;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const { data: runRow, error: runError } = await admin
    .from("enrichment_runs")
    .select(ENRICH_RUN_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (runError) {
    return NextResponse.json({ error: runError.message }, { status: 500 });
  }
  if (!runRow) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if ((runRow as unknown as { organization_id: string }).organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const items: unknown[] = [];
  for (let offset = 0; offset < MAX_ITEMS; offset += PAGE) {
    const { data, error } = await admin
      .from("enrichment_run_items")
      .select(ENRICH_ITEM_COLUMNS)
      .eq("run_id", id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const page = data ?? [];
    items.push(...page);
    if (page.length < PAGE) break;
  }

  return NextResponse.json({ run: runRow, items });
}
