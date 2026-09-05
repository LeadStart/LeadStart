import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import {
  MAPS_SEARCH_ACTOR_ID,
  coerceMapsAreas,
  type MapsArea,
  type MapsSearchLevers,
} from "@/lib/apify/sourcing/maps-search";
import { normalizeStateName } from "@/lib/geo/us-states";

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
// SPEND-05 (Apify spend audit 2026-08-30): compass bills places ≈ areas ×
// N_terms once the per-term cap floors at 1 (perSearch = max(1, ceil(cap/N)) in
// maps-search.ts:baseInput), so an uncapped term list (audience packs stack
// terms in one click) voids the target cap. Cap the term count here so billed
// places stay bounded by areas × MAX_TERMS regardless of the target. Authoritative
// server-side guard (the panel caps too, but this is the last line before spend).
const MAX_TERMS = 25;
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

const MAX_AREAS = 25;

// Validate + normalize the structured multi-region areas. coerceMapsAreas checks
// each level's required fields; on top we force every state to its full name
// ("TX" → "Texas") because the compass actor rejects abbreviations, and drop any
// city/county/state area whose state doesn't resolve to a real US state. ZIP
// areas need no state. Capped so one request can't fan out unboundedly.
function normalizeAreas(raw: unknown): MapsArea[] {
  const out: MapsArea[] = [];
  for (const area of coerceMapsAreas(raw)) {
    if (area.level === "zip") {
      out.push(area);
    } else {
      const full = area.state ? normalizeStateName(area.state) : null;
      if (!full) continue; // unrecognized state → not a usable area
      out.push({ ...area, state: full });
    }
    if (out.length >= MAX_AREAS) break;
  }
  return out;
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
  const dedupedTerms = Array.isArray(raw.searchTerms)
    ? Array.from(new Set(raw.searchTerms.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean)))
    : [];
  // SPEND-05: hard-cap the term count so billed places can't exceed
  // areas × MAX_TERMS × per-term cap. Trim (fail-safe) rather than reject, and
  // surface a note so the run still succeeds on the first MAX_TERMS terms.
  const termsTrimmed = dedupedTerms.length > MAX_TERMS;
  const terms = dedupedTerms.slice(0, MAX_TERMS);
  // Location is supplied EITHER as structured `areas` (the DIY multi-region path)
  // OR the legacy free-text `locationQuery`. Never both: structured wins, and
  // the cron's coerceMapsAreas keys off `areas` to fan out one run per region.
  const areas = normalizeAreas(raw.areas);
  const location = typeof raw.locationQuery === "string" ? raw.locationQuery.trim() : "";

  if (terms.length === 0) {
    return NextResponse.json(
      { error: "Add at least one search term (a niche or business type)" },
      { status: 400 },
    );
  }
  if (areas.length === 0 && !location) {
    return NextResponse.json(
      { error: "Add at least one area, a city, county, state, or ZIP" },
      { status: 400 },
    );
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
    ...(areas.length > 0 ? { areas } : { locationQuery: location }),
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
  const addons = {
    verify: addonsInput.verify === true,
    naming: addonsInput.naming === true,
    // Keep catch-all pattern guesses (flagged, confidence 40) for this search's
    // auto-enrichment instead of discarding them.
    include_catch_all: addonsInput.include_catch_all === true,
  };

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

  return NextResponse.json({
    search_id: (row as { id: string }).id,
    target: maxResults,
    ...(termsTrimmed
      ? { note: `Only the first ${MAX_TERMS} search terms were used (per-search spend cap).` }
      : {}),
  });
}
