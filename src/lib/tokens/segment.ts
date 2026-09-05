// Deterministic SEGMENT identity for the master-pool coverage readout (Phase 3)
// and the segment cache (Phase 4). A segment is the SIMPLE triple (vein +
// normalized search terms + normalized area): owner decision D4: broad dedup, a
// simple key, NOT the finer ICP facets. Two buyers who pull the same niche in the
// same place land on the same segment_key, so ownership/coverage aggregate and a
// fresh pull can be served from cache.
//
// Pure + isomorphic (no DB, no server-only) so it is unit-testable and shared by
// the promotion path, the coverage route, and (later) the cache serve.

import type { SearchKind } from "./pricing-math";
import { coerceMapsAreas, type MapsArea } from "@/lib/apify/sourcing/maps-search";

export interface Segment {
  key: string; // stable id: `${vein}:${hash}`
  vein: SearchKind;
  terms: string[]; // normalized, deduped, sorted: the human-readable "what"
  area: string; // normalized: the human-readable "where"
}

// A control char no user types: the field/term delimiter, so a term containing
// "|" or "," can never collide with the field boundary in the hashed input.
const SEP = "";

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function normList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [];
  const out = new Set<string>();
  for (const x of arr) {
    const n = norm(x);
    if (n) out.add(n);
  }
  return Array.from(out).sort();
}

// 32-bit FNV-1a → 8 hex chars. The key only groups coverage/cache; it never
// drives billing (ownership does), so a rare collision is cosmetic, not costly.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// One structured Maps area → a deterministic label (not the user-supplied display
// `label`, which is free-form). The identifying fields per level, normalized.
function mapsAreaLabel(a: MapsArea): string {
  switch (a.level) {
    case "zip":
      return norm(a.postalCode);
    case "state":
      return norm(a.state);
    case "county":
    case "city":
      return [norm(a.name), norm(a.state)].filter(Boolean).join(", ");
  }
}

function mapsTermsAndArea(query: unknown): { terms: string[]; area: string } {
  const q = (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
  const levers = (q.levers && typeof q.levers === "object" ? q.levers : {}) as Record<string, unknown>;
  const terms = normList(levers.searchTerms);
  const areas = coerceMapsAreas(levers.areas);
  const area =
    areas.length > 0
      ? Array.from(new Set(areas.map(mapsAreaLabel).filter(Boolean))).sort().join("; ")
      : norm(levers.locationQuery);
  return { terms, area };
}

function linkedInTermsAndArea(query: unknown): { terms: string[]; area: string } {
  const q = (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
  const levers = (q.levers && typeof q.levers === "object" ? q.levers : {}) as Record<string, unknown>;
  // Simple "what": the free-text query + the current job titles (the primary
  // targeting). Finer facets (industries, seniority, companies) are deliberately
  // excluded per D4: the segment stays broad.
  const terms = normList([
    ...(typeof levers.query === "string" ? [levers.query] : []),
    ...(Array.isArray(levers.currentJobTitles) ? levers.currentJobTitles : []),
  ]);
  const area = normList(levers.locations).join("; ");
  return { terms, area };
}

/**
 * The segment a search belongs to, or null when it can't be segmented (no terms
 * or no area). A null segment is not an error: promotion still grants ownership;
 * the contact simply isn't attributed to a coverage/cache segment.
 */
export function segmentForQuery(vein: SearchKind, query: unknown): Segment | null {
  const { terms, area } = vein === "maps" ? mapsTermsAndArea(query) : linkedInTermsAndArea(query);
  if (terms.length === 0 || !area) return null;
  const key = `${vein}:${fnv1a([vein, terms.join(SEP), area].join(SEP))}`;
  return { key, vein, terms, area };
}
