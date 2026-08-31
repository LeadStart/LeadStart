// POST /api/buyer/prospecting/resale — buyer "get the remaining contacts in this
// segment from the pool". Takes an existing search of theirs, resolves its segment,
// and serves the master-pool contacts they don't already own straight into their
// org (a copy + ownership + the same token charge, no actor run) via the explicit
// cache-serve path. Reuses the reserve -> serve -> settle billing exactly.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { maybeServeFromCache } from "@/lib/tokens/cache-serve";
import type { SearchKind } from "@/lib/tokens/pricing-math";

export async function POST(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "buyer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return NextResponse.json({ error: "No organization on account" }, { status: 400 });

  let body: { search_id?: unknown; kind?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const sourceSearchId = typeof body.search_id === "string" ? body.search_id : "";
  const kind: SearchKind = body.kind === "linkedin" ? "linkedin" : "maps";
  if (!sourceSearchId) return NextResponse.json({ error: "search_id is required." }, { status: 400 });

  const admin = createAdminClient();
  const table = kind === "maps" ? "maps_searches" : "linkedin_searches";
  const { data: srcRow } = await admin
    .from(table)
    .select("query, actor, target_max_results")
    .eq("id", sourceSearchId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const src = srcRow as { query: Record<string, unknown> | null; actor: string | null; target_max_results: number | null } | null;
  if (!src) return NextResponse.json({ error: "Search not found." }, { status: 404 });

  const searchId = randomUUID();
  const result = await maybeServeFromCache(admin, {
    organizationId,
    searchId,
    searchKind: kind,
    query: (src.query ?? {}) as Record<string, unknown>,
    targetMaxResults: src.target_max_results ?? 200,
    createdBy: user.id,
    actor: src.actor ?? "",
    explicit: true,
  });

  if (result.outcome === "served") {
    return NextResponse.json({ success: true, search_id: searchId, served: result.served, charged: result.charged });
  }
  if (result.outcome === "rejected") {
    const msg =
      result.reason === "insufficient_tokens"
        ? `Not enough tokens. This needs ${result.held ?? 0}; your balance is ${result.available ?? 0}.`
        : "Pricing isn't set yet.";
    return NextResponse.json({ error: msg, reason: result.reason, held: result.held }, { status: 400 });
  }
  // skip: resale not enabled, unsegmentable, or nothing new to add.
  return NextResponse.json({ success: true, served: 0, message: "Nothing new to add from the pool right now." });
}
