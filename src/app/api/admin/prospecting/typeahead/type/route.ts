import { NextRequest, NextResponse } from "next/server";
import { ScrapioClient } from "@/lib/scrapio/client";
import { requireProspectingContext } from "@/lib/scrapio/auth";

// POST /api/admin/prospecting/typeahead/type
// Body: { search_term: string }
//
// Returns Scrap.io categories matching the search term. The user picks
// one from the dropdown and the chosen `id` becomes `type` on /search.

type Body = { search_term?: unknown };

export async function POST(request: NextRequest) {
  const ctx = await requireProspectingContext();
  if ("error" in ctx) return ctx.error;

  const body = (await request.json().catch(() => ({}))) as Body;
  const searchTerm =
    typeof body.search_term === "string" ? body.search_term.trim() : "";
  if (!searchTerm) {
    return NextResponse.json(
      { error: "search_term required" },
      { status: 400 },
    );
  }

  const client = new ScrapioClient(ctx.apiKey);
  try {
    const results = await client.searchTypes(searchTerm);
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Lookup failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
