import { NextRequest, NextResponse } from "next/server";
import { ScrapioClient } from "@/lib/scrapio/client";
import { requireProspectingContext } from "@/lib/scrapio/auth";
import type { ScrapioLocation, ScrapioLocationType } from "@/lib/scrapio/types";

// POST /api/admin/prospecting/typeahead/location
// Body: { search_term: string, admin1_code?: string }
//
// Searches Scrap.io's /gmap/locations across admin1/admin2/city in
// parallel (or just admin2/city when admin1_code narrows the scope).
// Returns a flat list with each result tagged by the type that matched
// so the UI can render group labels ("State", "County", "City").

type Body = { search_term?: unknown; admin1_code?: unknown };

const TYPES_FULL: ScrapioLocationType[] = ["admin1", "admin2", "city"];
const TYPES_NARROW: ScrapioLocationType[] = ["admin2", "city"];

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
  const admin1Code =
    typeof body.admin1_code === "string" && body.admin1_code.trim()
      ? body.admin1_code.trim()
      : undefined;

  const client = new ScrapioClient(ctx.apiKey);
  const types = admin1Code ? TYPES_NARROW : TYPES_FULL;

  const settled = await Promise.allSettled(
    types.map(async (type) => {
      const items = await client.searchLocations({
        type,
        search_term: searchTerm,
        admin1_code: admin1Code,
      });
      return items.map((item) => ({
        id: item.id,
        text: item.text,
        search_type: type,
        parent_admin1: item.parent_admin1,
      }));
    }),
  );

  const results = settled
    .filter((r): r is PromiseFulfilledResult<Array<ScrapioLocation & { search_type: ScrapioLocationType }>> =>
      r.status === "fulfilled",
    )
    .flatMap((r) => r.value);

  return NextResponse.json({ results });
}
