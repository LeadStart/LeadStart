import { NextRequest, NextResponse } from "next/server";
import { ScrapioClient } from "@/lib/scrapio/client";
import { flattenPlace } from "@/lib/scrapio/flatten";
import { requireProspectingContext } from "@/lib/scrapio/auth";
import type { ScrapioBusiness } from "@/types/app";

// POST /api/admin/prospecting/search
//
// Body: {
//   type: string,           // Scrap.io category id (from /typeahead/type)
//   admin1_code: string,    // 2-letter US state code, e.g. "TX"
//   admin2_code?: string,   // optional county id
//   city?: string,          // optional city name
//   max_results?: number,   // 1-500, default 100. Hard cap on credits per search.
//   filters?: { ... }       // ScrapioFilters shape
// }
//
// Loops Scrap.io's cursor-paginated /gmap/search until we've collected
// max_results rows or hit MAX_PAGES_HARD. per_page is auto-derived from
// max_results (clamped to Scrap.io's 100-per-page ceiling) — the UI
// controls credit burn through max_results, not per_page.
//
// Each batch is one Scrap.io API call. With per_page=100 that means at
// most 5 calls per search (= 500 results = HARD_RESULT_CAP).

export const maxDuration = 60;

const HARD_RESULT_CAP = 1000;
const MAX_PAGES_HARD = 10;
const MIN_DELAY_MS = 300;

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
  const { user, organizationId, apiKey, admin } = ctx;

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
      : undefined;
  const city =
    typeof body.city === "string" && body.city.trim()
      ? body.city.trim()
      : undefined;

  const maxResults = clampInt(body.max_results, 1, HARD_RESULT_CAP, 100);
  const perPage = Math.min(maxResults, 100);

  const filters =
    body.filters && typeof body.filters === "object"
      ? (body.filters as Record<string, unknown>)
      : undefined;

  const client = new ScrapioClient(apiKey);

  const results: ScrapioBusiness[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let totalAvailable: number | null = null;

  try {
    while (pages < MAX_PAGES_HARD && results.length < maxResults) {
      const response = await client.search({
        type,
        admin1_code: admin1Code,
        admin2_code: admin2Code,
        city,
        per_page: perPage,
        cursor,
        filters,
      });
      const places = response.data ?? [];
      const meta = response.meta ?? {};
      if (pages === 0 && typeof meta.total === "number") {
        totalAvailable = meta.total;
      }
      for (const place of places) {
        if (results.length >= maxResults) break;
        results.push(flattenPlace(place));
      }
      pages++;
      cursor = meta.next_cursor ?? undefined;
      if (!cursor || places.length === 0 || results.length >= maxResults) break;
      // Pace Scrap.io to stay under their per-second cap. Replit used 300ms.
      await new Promise((r) => setTimeout(r, MIN_DELAY_MS));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    console.error("[admin/prospecting/search] Scrap.io call failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // truncated = there are more results in Scrap.io than what we returned.
  // Either because we hit max_results, or because the iteration stopped at
  // MAX_PAGES_HARD before the cursor ran out.
  const truncated =
    (totalAvailable !== null && results.length < totalAvailable) ||
    (cursor !== undefined && pages >= MAX_PAGES_HARD);

  const queryRecord = {
    type,
    admin1_code: admin1Code,
    admin2_code: admin2Code,
    city,
    max_results: maxResults,
    filters: filters ?? {},
  };

  const { data: insertedRows, error: insertError } = await admin
    .from("prospect_searches")
    .insert({
      organization_id: organizationId,
      created_by: user.id,
      query: queryRecord,
      results,
      result_count: results.length,
      pages_fetched: pages,
      truncated,
    })
    .select("id")
    .maybeSingle();
  if (insertError) {
    // Search itself succeeded — surface rows even if caching them failed.
    console.error(
      "[admin/prospecting/search] failed to persist prospect_searches row:",
      insertError,
    );
  }

  return NextResponse.json({
    success: true,
    search_id: (insertedRows as { id: string } | null)?.id ?? null,
    results,
    count: results.length,
    pages,
    total_available: totalAvailable,
    truncated,
  });
}
