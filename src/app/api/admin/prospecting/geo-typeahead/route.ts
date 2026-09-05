import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";

// GET /api/admin/prospecting/geo-typeahead?q=<term>&kinds=city,county,state
//
// Confirmatory location type-ahead over the shared geo_places gazetteer. Returns
// a handful of prefix matches per requested kind (balanced so a state isn't
// buried under 20 same-prefixed cities), each with a display label the picker
// turns into a MapsArea. Served by the service-role admin client (reference data,
// not org-scoped). The Maps picker asks for city/county/state; the future
// LinkedIn picker will ask for country/state/city off the SAME endpoint.

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const ALLOWED_KINDS = new Set(["country", "state", "county", "city"]);
const PER_KIND = 8;
const MIN_LEN = 2;

// Keep only characters that appear in real place names, so a user typing `%` or
// `_` can't turn the LIKE prefix into a wildcard match.
function sanitize(q: string): string {
  return q.replace(/[^\p{L}\p{N}\s.'-]/gu, "").trim().slice(0, 60);
}

function labelFor(kind: string, name: string, stateCode: string | null): string {
  if (kind === "state" || kind === "country") return name;
  return stateCode ? `${name}, ${stateCode}` : name;
}

export async function GET(request: NextRequest) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { admin } = ctx;

  const url = new URL(request.url);
  const q = sanitize(url.searchParams.get("q") ?? "");
  if (q.length < MIN_LEN) return NextResponse.json({ results: [] });

  const kindsParam = (url.searchParams.get("kinds") ?? "city,county,state")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => ALLOWED_KINDS.has(k));
  const kinds = kindsParam.length ? Array.from(new Set(kindsParam)) : ["city", "county", "state"];

  type GeoRow = {
    id: number;
    kind: string;
    name: string;
    state_code: string | null;
    state_name: string | null;
  };

  // One prefix query per kind (parallel), each capped: guarantees every group
  // is represented instead of the first kind eating the whole limit.
  const prefix = `${q}%`;
  const settled = await Promise.allSettled(
    kinds.map(async (kind): Promise<GeoRow[]> => {
      const { data, error } = await admin
        .from("geo_places")
        .select("id, kind, name, state_code, state_name")
        .eq("kind", kind)
        .ilike("name", prefix)
        .order("name", { ascending: true })
        .order("state_code", { ascending: true })
        .limit(PER_KIND);
      if (error) throw error;
      return (data ?? []) as GeoRow[];
    }),
  );

  const results = settled
    .filter((r): r is PromiseFulfilledResult<GeoRow[]> => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      state_code: row.state_code,
      state_name: row.state_name,
      label: labelFor(row.kind, row.name, row.state_code),
    }));

  return NextResponse.json({ results });
}
