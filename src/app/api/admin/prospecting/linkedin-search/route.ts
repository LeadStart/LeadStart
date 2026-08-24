import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import {
  buildProfileSearchInput,
  PROFILE_SEARCH_ACTOR_ID,
  type ProfileSearchDepth,
  type ProfileSearchLevers,
} from "@/lib/apify/sourcing/profile-search";

// POST /api/admin/prospecting/linkedin-search
//
// Body: { levers: ProfileSearchLevers, depth?: "short"|"full"|"full_email",
//         max_results?: number }
//
// Inserts a pending linkedin_searches row; the run-linkedin-searches cron starts
// the actor and polls it across ticks. One active search per org (partial unique
// index → pre-check + 23505 → 409). Mirrors the enrich/start guard shape.

export const maxDuration = 15;

const DEFAULT_MAX = 100;
const HARD_CAP = 2500;
const VALID_DEPTHS: ProfileSearchDepth[] = ["short", "full", "full_email"];

type Body = { levers?: ProfileSearchLevers; depth?: unknown; max_results?: unknown };

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function POST(request: NextRequest) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { user, organizationId, admin, apifyToken } = ctx;

  if (!apifyToken) {
    return NextResponse.json(
      { error: "Apify API token not set. Save it in /admin/settings/api first." },
      { status: 400 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as Body;
  const levers: ProfileSearchLevers = body.levers ?? {};
  const depth: ProfileSearchDepth = VALID_DEPTHS.includes(body.depth as ProfileSearchDepth)
    ? (body.depth as ProfileSearchDepth)
    : "short";
  const maxResults = clampInt(body.max_results, 1, HARD_CAP, DEFAULT_MAX);

  // Guard an unbounded search: the built input must carry at least one real
  // filter beyond the three always-present control keys.
  const input = buildProfileSearchInput(levers, { depth, maxItems: maxResults });
  const CONTROL_KEYS = new Set([
    "profileScraperMode",
    "maxItems",
    "takePages",
    "autoQuerySegmentation",
    "autoQuerySegmentationLevels",
  ]);
  const constraintKeys = Object.keys(input).filter((k) => !CONTROL_KEYS.has(k));
  if (constraintKeys.length === 0) {
    return NextResponse.json(
      { error: "Add at least one filter (keywords, job title, location, …) before searching" },
      { status: 400 },
    );
  }

  // One active search per org (pre-check; the unique index is the real race guard).
  const { data: activeRows } = await admin
    .from("linkedin_searches")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running"])
    .limit(1);
  if (activeRows && activeRows.length > 0) {
    return NextResponse.json(
      {
        error: "A LinkedIn search is already running for this organization",
        active_search_id: (activeRows[0] as { id: string }).id,
      },
      { status: 409 },
    );
  }

  const { data: row, error } = await admin
    .from("linkedin_searches")
    .insert({
      organization_id: organizationId,
      created_by: user.id,
      query: { levers, depth },
      results: [],
      result_count: 0,
      target_max_results: maxResults,
      status: "pending",
      actor: PROFILE_SEARCH_ACTOR_ID,
    })
    .select("id")
    .single();

  if (error || !row) {
    if ((error as { code?: string } | null)?.code === "23505") {
      return NextResponse.json(
        { error: "A LinkedIn search is already running for this organization" },
        { status: 409 },
      );
    }
    console.error("[linkedin-search] insert failed:", error);
    return NextResponse.json({ error: error?.message ?? "Failed to start search" }, { status: 500 });
  }

  return NextResponse.json({ search_id: (row as { id: string }).id, target: maxResults });
}
