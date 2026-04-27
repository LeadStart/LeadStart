import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { ScrapioClient } from "@/lib/scrapio/client";
import { flattenPlace } from "@/lib/scrapio/flatten";
import type { ScrapioBusiness } from "@/types/app";

// GET /api/cron/run-prospect-searches
//
// Worker tick. Picks one prospect_searches row in 'pending' or 'running'
// status and processes a chunk of pages (up to PAGES_PER_TICK). Persists
// progress and the next Scrap.io cursor between ticks so a long search
// resumes seamlessly across many runs.
//
// On every successful page, the fetched google_ids are pushed to Scrap.io's
// blacklist (fire-and-forget). Future searches automatically skip those
// rows AND don't count them toward credits — that's the dedup guarantee.

export const maxDuration = 60;

// 8 pages × 50 per page = 400 results per tick. Each page is ~3-5s plus
// 300ms throttle, so a tick runs ~30-45s — comfortably under Vercel's 60s
// budget. A 5000-result search completes in ~13 ticks (~13 minutes at the
// 1-per-minute cron schedule).
const PAGES_PER_TICK = 8;
const PER_PAGE = 50;
const MIN_DELAY_MS = 300;

type SearchRow = {
  id: string;
  organization_id: string;
  query: Record<string, unknown>;
  results: ScrapioBusiness[] | null;
  result_count: number;
  pages_fetched: number;
  next_cursor: string | null;
  target_max_results: number;
  started_at: string | null;
};

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // Find the oldest active row.
  const { data: candidates } = await admin
    .from("prospect_searches")
    .select(
      "id, organization_id, query, results, result_count, pages_fetched, next_cursor, target_max_results, started_at",
    )
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: true })
    .limit(1);

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ status: "idle" });
  }

  const candidate = candidates[0] as SearchRow;
  const claimAt = new Date().toISOString();

  // Atomic claim — only one cron instance succeeds if two run at once.
  const { data: claimedRows } = await admin
    .from("prospect_searches")
    .update({
      status: "running",
      started_at: candidate.started_at ?? claimAt,
    })
    .eq("id", candidate.id)
    .in("status", ["pending", "running"])
    .select(
      "id, organization_id, query, results, result_count, pages_fetched, next_cursor, target_max_results, started_at",
    );

  if (!claimedRows || claimedRows.length === 0) {
    return NextResponse.json({ status: "claim_failed", id: candidate.id });
  }
  const search = claimedRows[0] as SearchRow;

  // Fetch the org's Scrap.io API key (with env fallback for local dev).
  const { data: org } = await admin
    .from("organizations")
    .select("scrapio_api_key")
    .eq("id", search.organization_id)
    .maybeSingle();
  const apiKey =
    (org as { scrapio_api_key: string | null } | null)?.scrapio_api_key ||
    process.env.SCRAPIO_API_KEY ||
    "";
  if (!apiKey) {
    await admin
      .from("prospect_searches")
      .update({
        status: "failed",
        error_message:
          "No Scrap.io API key on organization (and SCRAPIO_API_KEY env not set)",
        completed_at: new Date().toISOString(),
      })
      .eq("id", search.id);
    return NextResponse.json({
      status: "failed",
      id: search.id,
      error: "no_api_key",
    });
  }

  const client = new ScrapioClient(apiKey);
  const blacklistName = `leadstart-${search.organization_id}`;

  const query = search.query;
  const targetMax = search.target_max_results;

  let results: ScrapioBusiness[] = Array.isArray(search.results)
    ? [...search.results]
    : [];
  let cursor: string | undefined = search.next_cursor ?? undefined;
  let pages = search.pages_fetched ?? 0;
  let totalAvailable: number | null = null;
  let pagesThisTick = 0;
  let cursorExhausted = false;

  try {
    while (
      pagesThisTick < PAGES_PER_TICK &&
      results.length < targetMax
    ) {
      const response = await client.search({
        type: query.type as string,
        admin1_code: query.admin1_code as string,
        admin2_code:
          (query.admin2_code as string | null | undefined) ?? undefined,
        city: (query.city as string | null | undefined) ?? undefined,
        per_page: PER_PAGE,
        cursor,
        filters:
          (query.filters as Record<string, unknown> | undefined) ?? undefined,
      });

      const places = response.data ?? [];
      const meta = response.meta ?? {};
      if (pages === 0 && typeof meta.total === "number") {
        totalAvailable = meta.total;
      }

      const newRows: ScrapioBusiness[] = [];
      for (const place of places) {
        if (results.length + newRows.length >= targetMax) break;
        newRows.push(flattenPlace(place));
      }
      results = [...results, ...newRows];
      pages++;
      pagesThisTick++;
      cursor = meta.next_cursor ?? undefined;

      // Push google_ids to Scrap.io blacklist asynchronously. Failures
      // here only mean the user pays credits for those rows next time —
      // recoverable, so don't block the search on blacklist success.
      const idsToBlacklist = newRows
        .map((r) => r.google_id)
        .filter((id): id is string => Boolean(id));
      if (idsToBlacklist.length > 0) {
        client
          .blacklistAdd(blacklistName, "google_id", idsToBlacklist)
          .catch((err) =>
            console.error(
              `[cron/run-prospect-searches] blacklist push failed for search ${search.id}:`,
              err,
            ),
          );
      }

      if (!cursor || places.length === 0) {
        cursorExhausted = true;
        break;
      }
      if (results.length >= targetMax) break;

      await new Promise((r) => setTimeout(r, MIN_DELAY_MS));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[cron/run-prospect-searches] search ${search.id} threw:`,
      err,
    );
    await admin
      .from("prospect_searches")
      .update({
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
        results,
        result_count: results.length,
        pages_fetched: pages,
        next_cursor: cursor ?? null,
      })
      .eq("id", search.id);
    return NextResponse.json({
      status: "failed",
      id: search.id,
      error: message,
    });
  }

  const isDone =
    cursorExhausted || results.length >= targetMax || !cursor;
  const truncated =
    isDone &&
    ((totalAvailable !== null && results.length < totalAvailable) ||
      Boolean(cursor));

  const progress = isDone
    ? `${results.length} results across ${pages} pages`
    : `Running… page ${pages} fetched · ${results.length} results so far`;

  await admin
    .from("prospect_searches")
    .update({
      status: isDone ? "complete" : "running",
      results,
      result_count: results.length,
      pages_fetched: pages,
      next_cursor: cursor ?? null,
      truncated,
      progress_message: progress,
      completed_at: isDone ? new Date().toISOString() : null,
    })
    .eq("id", search.id);

  return NextResponse.json({
    status: isDone ? "complete" : "running",
    id: search.id,
    results_so_far: results.length,
    pages,
    pages_this_tick: pagesThisTick,
  });
}
