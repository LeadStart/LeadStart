// POST /api/buyer/prospecting/maps-search — buyer-initiated, reserve-wrapped
// Google-Maps sourcing. Reserves worst-case retail tokens (gating on pricing +
// balance) BEFORE the search becomes grabbable, then inserts the pending row the
// existing run-maps-searches cron picks up. The reserve-first ordering is
// race-free: token_ledger.search_id has no FK, so we pre-generate the id, place
// the hold against it, and only then insert the search with that same id.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  MAPS_SEARCH_ACTOR_ID,
  coerceMapsAreas,
  type MapsSearchLevers,
} from "@/lib/apify/sourcing/maps-search";
import { placeHold } from "@/lib/tokens/billing";
import { maybeServeFromCache } from "@/lib/tokens/cache-serve";

const DEFAULT_MAX = 200;
const HARD_CAP = 2000;
const MAX_TERMS = 25;

export async function POST(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "buyer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return NextResponse.json({ error: "No organization on account" }, { status: 400 });

  let body: { search_terms?: unknown; areas?: unknown; location_query?: unknown; max_results?: unknown; name?: unknown; verify?: unknown; naming?: unknown; include_catch_all?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const searchTerms = Array.isArray(body.search_terms)
    ? body.search_terms.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()).slice(0, MAX_TERMS)
    : [];
  if (searchTerms.length === 0) {
    return NextResponse.json({ error: "At least one search term is required." }, { status: 400 });
  }

  const areas = coerceMapsAreas(body.areas);
  const locationQuery = typeof body.location_query === "string" ? body.location_query.trim() : "";
  if (areas.length === 0 && !locationQuery) {
    return NextResponse.json({ error: "A location (area or query) is required." }, { status: 400 });
  }

  let maxResults = Number(body.max_results);
  if (!Number.isFinite(maxResults) || maxResults <= 0) maxResults = DEFAULT_MAX;
  maxResults = Math.max(1, Math.min(HARD_CAP, Math.floor(maxResults)));

  const addons = { verify: !!body.verify, naming: !!body.naming, include_catch_all: !!body.include_catch_all };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const levers: MapsSearchLevers = {
    searchTerms,
    ...(areas.length > 0 ? { areas } : { locationQuery }),
  } as MapsSearchLevers;

  const admin = createAdminClient();
  const searchId = randomUUID();
  const searchQuery = { levers, addons, ...(name ? { name } : {}) };

  // Try the segment cache first (the resale path; OFF by default). If a fresh
  // pull of this segment holds contacts the buyer doesn't own, they're served +
  // owned + charged here with no actor run. `skip` falls through to fresh sourcing.
  const cache = await maybeServeFromCache(admin, {
    organizationId,
    searchId,
    searchKind: "maps",
    query: searchQuery,
    targetMaxResults: maxResults,
    createdBy: user.id,
    actor: MAPS_SEARCH_ACTOR_ID,
  });
  if (cache.outcome === "served") {
    return NextResponse.json({ success: true, search_id: searchId, served_from_cache: true, served: cache.served, charged: cache.charged });
  }
  if (cache.outcome === "rejected") {
    const msg =
      cache.reason === "insufficient_tokens"
        ? `Not enough tokens. This search needs ${cache.held ?? 0}; your balance is ${cache.available ?? 0}.`
        : "Sourcing isn't available yet — pricing hasn't been set.";
    return NextResponse.json({ error: msg, reason: cache.reason, held: cache.held }, { status: 400 });
  }

  // Reserve first (checks pricing + balance).
  const hold = await placeHold(admin, { organizationId, searchId, searchKind: "maps", targetMaxResults: maxResults });
  if (!hold.ok) {
    const msg =
      hold.reason === "insufficient_tokens"
        ? `Not enough tokens. This search reserves ${hold.held}; your balance is ${hold.available ?? 0}.`
        : hold.reason === "pricing_not_configured"
          ? "Sourcing isn't available yet — pricing hasn't been set."
          : "Could not reserve tokens for this search.";
    return NextResponse.json({ error: msg, reason: hold.reason, held: hold.held }, { status: 400 });
  }

  const { error } = await admin.from("maps_searches").insert({
    id: searchId,
    organization_id: organizationId,
    created_by: user.id,
    query: searchQuery,
    results: [],
    result_count: 0,
    target_max_results: maxResults,
    status: "pending",
    actor: MAPS_SEARCH_ACTOR_ID,
  } as Record<string, unknown>);

  if (error) {
    // Roll the hold back — the search won't run.
    await admin.from("token_ledger").delete().eq("search_id", searchId).eq("entry_type", "hold");
    const conflict = /duplicate|unique|23505/i.test(error.message);
    return NextResponse.json(
      { error: conflict ? "You already have a search running — wait for it to finish." : "Could not start the search." },
      { status: conflict ? 409 : 500 },
    );
  }

  return NextResponse.json({ success: true, search_id: searchId, held: hold.held });
}
