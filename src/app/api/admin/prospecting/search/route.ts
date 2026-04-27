import { NextRequest, NextResponse } from "next/server";
import { requireProspectingContext } from "@/lib/scrapio/auth";

// POST /api/admin/prospecting/search
//
// Body: {
//   type: string,           // Scrap.io category id (from /typeahead/type)
//   admin1_code: string,    // 2-letter US state code, e.g. "TX"
//   admin2_code?: string,   // optional county id
//   city?: string,          // optional city name
//   max_results?: number,   // 1-5000, default 100. Background worker
//                           // stops once this many results are collected.
//   filters?: { ... }       // ScrapioFilters shape
// }
//
// Returns { search_id } immediately. The actual fetching happens in the
// /api/cron/run-prospect-searches worker which polls for pending rows
// every minute and processes them in chunks. The frontend polls the
// status endpoint to render live progress.

export const maxDuration = 10;

const HARD_RESULT_CAP = 5000;

type SearchBody = {
  type?: unknown;
  admin1_code?: unknown;
  admin2_code?: unknown;
  city?: unknown;
  max_results?: unknown;
  filters?: unknown;
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export async function POST(request: NextRequest) {
  const ctx = await requireProspectingContext();
  if ("error" in ctx) return ctx.error;
  const { user, organizationId, admin } = ctx;

  const body = (await request.json().catch(() => ({}))) as SearchBody;
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const admin1Code =
    typeof body.admin1_code === "string" ? body.admin1_code.trim() : "";
  if (!type || !admin1Code) {
    return NextResponse.json(
      { error: "type and admin1_code are required" },
      { status: 400 },
    );
  }
  const admin2Code =
    typeof body.admin2_code === "string" && body.admin2_code.trim()
      ? body.admin2_code.trim()
      : null;
  const city =
    typeof body.city === "string" && body.city.trim()
      ? body.city.trim()
      : null;

  const maxResults = clampInt(body.max_results, 1, HARD_RESULT_CAP, 100);

  const filters =
    body.filters && typeof body.filters === "object"
      ? (body.filters as Record<string, unknown>)
      : {};

  const queryRecord = {
    type,
    admin1_code: admin1Code,
    admin2_code: admin2Code,
    city,
    max_results: maxResults,
    filters,
  };

  const { data: row, error } = await admin
    .from("prospect_searches")
    .insert({
      organization_id: organizationId,
      created_by: user.id,
      query: queryRecord,
      results: [],
      result_count: 0,
      pages_fetched: 0,
      truncated: false,
      status: "pending",
      target_max_results: maxResults,
    })
    .select("id")
    .single();

  if (error || !row) {
    console.error("[admin/prospecting/search] insert failed:", error);
    return NextResponse.json(
      { error: error?.message ?? "Failed to queue search" },
      { status: 500 },
    );
  }

  return NextResponse.json({ search_id: (row as { id: string }).id });
}
