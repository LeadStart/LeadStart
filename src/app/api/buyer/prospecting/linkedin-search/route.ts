// POST /api/buyer/prospecting/linkedin-search — buyer-initiated, reserve-wrapped
// LinkedIn sourcing. Same reserve-first ordering as the Maps buyer route: place
// the hold against a pre-generated id, then insert the pending linkedin_searches
// row the run-linkedin-searches cron picks up.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  PROFILE_SEARCH_ACTOR_ID,
  type ProfileSearchDepth,
  type ProfileSearchLevers,
} from "@/lib/apify/sourcing/profile-search";
import { placeHold } from "@/lib/tokens/billing";
import { maybeServeFromCache } from "@/lib/tokens/cache-serve";

const DEFAULT_MAX = 100;
const HARD_CAP = 1000;
const DEPTHS: ProfileSearchDepth[] = ["short", "full", "full_email"];

export async function POST(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "buyer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return NextResponse.json({ error: "No organization on account" }, { status: 400 });

  let body: { levers?: unknown; depth?: unknown; max_results?: unknown; name?: unknown; verify?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body.levers || typeof body.levers !== "object") {
    return NextResponse.json({ error: "Search filters are required." }, { status: 400 });
  }
  const levers = body.levers as ProfileSearchLevers;
  const depth: ProfileSearchDepth = DEPTHS.includes(body.depth as ProfileSearchDepth)
    ? (body.depth as ProfileSearchDepth)
    : "short";

  let maxResults = Number(body.max_results);
  if (!Number.isFinite(maxResults) || maxResults <= 0) maxResults = DEFAULT_MAX;
  maxResults = Math.max(1, Math.min(HARD_CAP, Math.floor(maxResults)));

  const addons = { verify: !!body.verify };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";

  const admin = createAdminClient();
  const searchId = randomUUID();
  const searchQuery = { levers, depth, addons, ...(name ? { name } : {}) };

  // Try the segment cache first (resale path; OFF by default). `skip` falls
  // through to fresh sourcing with the same pre-generated searchId.
  const cache = await maybeServeFromCache(admin, {
    organizationId,
    searchId,
    searchKind: "linkedin",
    query: searchQuery,
    targetMaxResults: maxResults,
    createdBy: user.id,
    actor: PROFILE_SEARCH_ACTOR_ID,
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

  const hold = await placeHold(admin, { organizationId, searchId, searchKind: "linkedin", targetMaxResults: maxResults });
  if (!hold.ok) {
    const msg =
      hold.reason === "insufficient_tokens"
        ? `Not enough tokens. This search reserves ${hold.held}; your balance is ${hold.available ?? 0}.`
        : hold.reason === "pricing_not_configured"
          ? "Sourcing isn't available yet — pricing hasn't been set."
          : "Could not reserve tokens for this search.";
    return NextResponse.json({ error: msg, reason: hold.reason, held: hold.held }, { status: 400 });
  }

  const { error } = await admin.from("linkedin_searches").insert({
    id: searchId,
    organization_id: organizationId,
    created_by: user.id,
    query: searchQuery,
    results: [],
    result_count: 0,
    target_max_results: maxResults,
    status: "pending",
    actor: PROFILE_SEARCH_ACTOR_ID,
  } as Record<string, unknown>);

  if (error) {
    await admin.from("token_ledger").delete().eq("search_id", searchId).eq("entry_type", "hold");
    const conflict = /duplicate|unique|23505/i.test(error.message);
    return NextResponse.json(
      { error: conflict ? "You already have a search running — wait for it to finish." : "Could not start the search." },
      { status: conflict ? 409 : 500 },
    );
  }

  return NextResponse.json({ success: true, search_id: searchId, held: hold.held });
}
