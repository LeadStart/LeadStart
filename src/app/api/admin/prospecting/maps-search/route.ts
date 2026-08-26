import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import { MAPS_SEARCH_ACTOR_ID, type MapsSearchLevers } from "@/lib/apify/sourcing/maps-search";

// POST /api/admin/prospecting/maps-search
//
// Body: { levers: MapsSearchLevers, max_results?, name?, addons?: { verify?,
//         naming? }, preset_slug? }. Inserts a pending maps_searches row; the
// run-maps-searches cron starts the compass actor and polls across ticks. One
// active search per org (partial unique index → pre-check + 23505 → 409). The
// Google-Maps twin of the linkedin-search POST.

export const maxDuration = 15;

const DEFAULT_MAX = 200;
const HARD_CAP = 5000;
const MAX_NAME = 80;
const VALID_WEBSITE = new Set(["all", "with", "without"]);

type Body = {
  levers?: MapsSearchLevers;
  max_results?: unknown;
  name?: unknown;
  addons?: unknown;
  preset_slug?: unknown;
};

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
  const raw = body.levers ?? {};
  const terms = Array.isArray(raw.searchTerms)
    ? Array.from(new Set(raw.searchTerms.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean)))
    : [];
  const location = typeof raw.locationQuery === "string" ? raw.locationQuery.trim() : "";

  if (terms.length === 0) {
    return NextResponse.json(
      { error: "Add at least one search term (a niche or business type)" },
      { status: 400 },
    );
  }
  if (!location) {
    return NextResponse.json({ error: "Add a location (city + state, or a state)" }, { status: 400 });
  }

  const websiteFilter = VALID_WEBSITE.has(raw.websiteFilter as string)
    ? (raw.websiteFilter as "all" | "with" | "without")
    : "all";
  const minStars = typeof raw.minStars === "string" ? raw.minStars.trim() : "";
  const categoryFilterWords = Array.isArray(raw.categoryFilterWords)
    ? raw.categoryFilterWords.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean)
    : [];

  const levers: MapsSearchLevers = {
    searchTerms: terms,
    locationQuery: location,
    websiteFilter,
    ...(minStars ? { minStars } : {}),
    ...(categoryFilterWords.length ? { categoryFilterWords } : {}),
  };

  const maxResults = clampInt(body.max_results, 1, HARD_CAP, DEFAULT_MAX);
  const name = (typeof body.name === "string" ? body.name : "").trim().slice(0, MAX_NAME);
  const presetSlug = (typeof body.preset_slug === "string" ? body.preset_slug : "").trim().slice(0, MAX_NAME);
  // Add-ons (both default OFF). `naming` (owner-name discovery) is wired in
  // Phase 3; storing it now is harmless (normalizeAddons ignores unknown keys
  // until then). `verify` runs the Million Verifier phase.
  const addonsInput =
    body.addons && typeof body.addons === "object" ? (body.addons as Record<string, unknown>) : {};
  const addons = { verify: addonsInput.verify === true, naming: addonsInput.naming === true };

  // One active search per org (pre-check; the unique index is the real race guard).
  const { data: activeRows } = await admin
    .from("maps_searches")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running"])
    .limit(1);
  if (activeRows && activeRows.length > 0) {
    return NextResponse.json(
      {
        error: "A Google Maps search is already running for this organization",
        active_search_id: (activeRows[0] as { id: string }).id,
      },
      { status: 409 },
    );
  }

  const { data: row, error } = await admin
    .from("maps_searches")
    .insert({
      organization_id: organizationId,
      created_by: user.id,
      query: { levers, addons, ...(name ? { name } : {}), ...(presetSlug ? { preset_slug: presetSlug } : {}) },
      results: [],
      result_count: 0,
      target_max_results: maxResults,
      status: "pending",
      actor: MAPS_SEARCH_ACTOR_ID,
    })
    .select("id")
    .single();

  if (error || !row) {
    if ((error as { code?: string } | null)?.code === "23505") {
      return NextResponse.json(
        { error: "A Google Maps search is already running for this organization" },
        { status: 409 },
      );
    }
    console.error("[maps-search] insert failed:", error);
    return NextResponse.json({ error: error?.message ?? "Failed to start search" }, { status: 500 });
  }

  return NextResponse.json({ search_id: (row as { id: string }).id, target: maxResults });
}
