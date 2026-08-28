import type { MapsPlace } from "@/types/app";
import { normalizeDomain } from "../domain";

// Google Maps business-search sourcing — the second top-of-funnel actor (the
// LinkedIn twin is profile-search.ts). Finds NEW businesses by niche keywords +
// location; the enrichment waterfall then fills their emails/phones. Pure module:
// builds the actor input from app-facing levers and flattens the dataset into
// de-duplicated MapsPlace rows. DB/worker wiring lives in run-maps-searches.
//
// Verified live 2026-08-25 (compass~google-maps-extractor default build):
//   charge events: `place-scraped` (primary, tiered FREE $0.005 → DIAMOND $0.0008),
//     `filter-applied` (FREE $0.001; billed = places × price × #filters),
//     `place-details-scraped` ($0.002), `contact-details-scraped` (company enrich).
//   `website` enum: allPlaces | withWebsite | withoutWebsite (default allPlaces).
//   output fields: placeId, title, categoryName, categories[], website, phone,
//     phoneUnformatted, address, street, city, state, postalCode, countryCode,
//     location{lat,lng}, totalScore, reviewsCount, permanentlyClosed,
//     temporarilyClosed, claimThisBusiness, url. (No email — we enrich ourselves.)
export const MAPS_SEARCH_ACTOR_ID =
  process.env.MAPS_SEARCH_ACTOR_ID?.trim() || "compass~google-maps-extractor";

// A single, disambiguated search area mapped to the compass actor's STRUCTURED
// geolocation fields. The actor nests Country ⊃ State ⊃ County ⊃ City and
// intersects them, so those combine to disambiguate ("Dallas County" + "Texas");
// ZIP (a ZCTA, outside that hierarchy) pairs with Country ONLY, one at a time.
// The actor wants full state NAMES ("Texas", not "TX"). One MapsArea = one actor
// run; a multi-region search fans out one run per area and merges by place-id.
export type MapsAreaLevel = "city" | "county" | "state" | "zip";
export interface MapsArea {
  level: MapsAreaLevel;
  name?: string; // city ("Dallas") or county ("Dallas County") name
  state?: string; // full state NAME ("Texas") — city/county/state levels
  postalCode?: string; // ZIP — zip level only
  countryCode?: string; // ISO-2, default "us"
  label?: string; // display only, e.g. "Dallas County, TX"
}

// App-facing levers. searchTerms are OR'd across searches. Location is supplied
// EITHER as `areas` (structured, one-or-more regions — the DIY path) OR as the
// legacy free-text `locationQuery` (one area). websiteFilter/minStars/
// categoryFilterWords each add a per-place filter charge, so they're sent ONLY
// when explicitly set.
export interface MapsSearchLevers {
  searchTerms?: string[];
  areas?: MapsArea[];
  locationQuery?: string;
  websiteFilter?: "all" | "with" | "without";
  minStars?: string; // "" | "3.5" | "4.0" | "4.5"
  categoryFilterWords?: string[];
}

const MAX_ITEMS_CAP = 5000;
const PER_SEARCH_CAP = 2000;

function cleanArr(v?: string[]): string[] | undefined {
  if (!v) return undefined;
  const out = Array.from(new Set(v.map((s) => s.trim()).filter(Boolean)));
  return out.length ? out : undefined;
}

// The parts of the actor input shared by both the legacy free-text path and the
// structured per-area path: the search terms, the per-search cap, and the
// detail/contacts opt-outs (we enrich domains ourselves — far cheaper than the
// actor's per-place add-on events).
function baseInput(levers: MapsSearchLevers, opts: { maxItems: number }): Record<string, unknown> {
  const terms = cleanArr(levers.searchTerms) ?? [];
  const cap = Math.max(1, Math.min(MAX_ITEMS_CAP, Math.round(opts.maxItems)));
  const perSearch = Math.max(1, Math.min(PER_SEARCH_CAP, Math.ceil(cap / Math.max(1, terms.length))));
  return {
    searchStringsArray: terms,
    maxCrawledPlacesPerSearch: perSearch,
    language: "en",
    scrapePlaceDetailPage: false,
    scrapeContacts: false,
    maximumLeadsEnrichmentRecords: 0,
  };
}

// Each filter option adds a per-place `filter-applied` charge (billed = places ×
// filter_price × #filters), so send them ONLY when the user asked. Closed places
// are dropped for free in parseMapsSearchResults instead of via skipClosedPlaces
// (which would bill a filter on every place). Mutates `input`.
function applyFilters(input: Record<string, unknown>, levers: MapsSearchLevers): void {
  if (levers.websiteFilter === "with") input.website = "withWebsite";
  else if (levers.websiteFilter === "without") input.website = "withoutWebsite";
  const minStars = levers.minStars?.trim();
  if (minStars) input.placeMinimumStars = minStars;
  const cats = cleanArr(levers.categoryFilterWords);
  if (cats) input.categoryFilterWords = cats;
}

// Map ONE area to the actor's structured 📡 Geolocation fields. Deliberately
// omits `locationQuery` — the actor gives the 📍 Location field priority over
// Geolocation, so a stray locationQuery would silently override these.
export function geoFieldsForArea(area: MapsArea): Record<string, unknown> {
  const g: Record<string, unknown> = { countryCode: (area.countryCode || "us").toLowerCase() };
  const name = area.name?.trim();
  const state = area.state?.trim();
  const zip = area.postalCode?.trim();
  switch (area.level) {
    case "zip":
      if (zip) g.postalCode = zip; // Country + ZIP only — never combine with city
      break;
    case "state":
      if (state) g.state = state;
      break;
    case "county":
      if (state) g.state = state;
      if (name) g.county = name;
      break;
    case "city":
      if (state) g.state = state;
      if (name) g.city = name;
      break;
  }
  return g;
}

// Legacy free-text builder (one area via `locationQuery`) — kept for searches
// created before the structured/multi-region path and any non-DIY caller.
export function buildMapsSearchInput(
  levers: MapsSearchLevers,
  opts: { maxItems: number },
): Record<string, unknown> {
  const input = baseInput(levers, opts);
  input.locationQuery = levers.locationQuery?.trim() ?? "";
  applyFilters(input, levers);
  return input;
}

// Structured builder for ONE area of a (possibly multi-region) search. `maxItems`
// is this area's slice of the total cap — the cron divides target_max_results
// across the areas so the fan-out doesn't over-scrape.
export function buildMapsSearchInputForArea(
  levers: MapsSearchLevers,
  area: MapsArea,
  opts: { maxItems: number },
): Record<string, unknown> {
  const input = baseInput(levers, opts);
  Object.assign(input, geoFieldsForArea(area));
  applyFilters(input, levers);
  return input;
}

// ---------- Multi-region fan-out (Phase 2) ----------
//
// A DIY search may carry several structured `areas`. The compass actor takes one
// geolocation per run, so the cron fans out ONE run per area, sequentially, and
// accumulates a de-duplicated union of places across areas. These pure helpers
// hold the fan-out arithmetic + dedupe so the cron stays thin and the logic is
// unit-testable without Apify or the DB.

const VALID_AREA_LEVELS: readonly MapsAreaLevel[] = ["city", "county", "state", "zip"];

// Coerce one stored/incoming value into a usable MapsArea, or null if it can't
// address a real area. The level's identifying field is required (zip→postalCode;
// city/county→name+state; state→state) — a half-filled area would silently widen
// the search (e.g. a city with no state hits every same-named city nationwide).
export function coerceMapsArea(raw: unknown): MapsArea | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const level = typeof r.level === "string" ? (r.level as MapsAreaLevel) : null;
  if (!level || !VALID_AREA_LEVELS.includes(level)) return null;

  const name = typeof r.name === "string" ? r.name.trim() : "";
  const state = typeof r.state === "string" ? r.state.trim() : "";
  const postalCode = typeof r.postalCode === "string" ? r.postalCode.trim() : "";
  const countryCode =
    typeof r.countryCode === "string" && r.countryCode.trim()
      ? r.countryCode.trim().toLowerCase()
      : "us";
  const label = typeof r.label === "string" ? r.label.trim() : "";

  if (level === "zip" && !postalCode) return null;
  if ((level === "city" || level === "county") && (!name || !state)) return null;
  if (level === "state" && !state) return null;

  const area: MapsArea = { level, countryCode };
  if (name) area.name = name;
  if (state) area.state = state;
  if (postalCode) area.postalCode = postalCode;
  if (label) area.label = label;
  return area;
}

// The valid structured areas of a search, in order. Empty ⇒ NOT a multi-region
// search → the caller uses the legacy free-text `locationQuery` path.
export function coerceMapsAreas(raw: unknown): MapsArea[] {
  if (!Array.isArray(raw)) return [];
  const out: MapsArea[] = [];
  for (const item of raw) {
    const a = coerceMapsArea(item);
    if (a) out.push(a);
  }
  return out;
}

// This area's slice of the overall target. Dividing the cap across areas keeps a
// multi-region search from scraping `target × areaCount` places (and paying for
// them). ceil so the union can still reach the target after cross-area dedupe.
export function perAreaMaxItems(target: number, areaCount: number): number {
  const t = Number.isFinite(target) ? Math.max(1, Math.round(target)) : 1;
  const n = Number.isFinite(areaCount) ? Math.max(1, Math.round(areaCount)) : 1;
  return Math.max(1, Math.ceil(t / n));
}

// Union two place lists, de-duplicated by google_place_id, existing-wins (a place
// seen in an earlier area is not replaced by a later area's copy). Order-stable:
// existing first, then first-seen new places. Places without an id are dropped
// (they can't be dedupe-keyed — parseMapsSearchResults already excludes them).
export function mergeMapsPlaces(existing: MapsPlace[], incoming: MapsPlace[]): MapsPlace[] {
  const seen = new Set<string>();
  const out: MapsPlace[] = [];
  for (const p of existing) {
    if (!p?.google_place_id || seen.has(p.google_place_id)) continue;
    seen.add(p.google_place_id);
    out.push(p);
  }
  for (const p of incoming) {
    if (!p?.google_place_id || seen.has(p.google_place_id)) continue;
    seen.add(p.google_place_id);
    out.push(p);
  }
  return out;
}

export interface IngestAreaResult {
  nextAreaIndex: number; // the cursor to persist (areaIndex + 1)
  accumulated: MapsPlace[]; // the running de-duplicated union across areas so far
  done: boolean; // true once every area has been ingested
  finalResults?: MapsPlace[]; // present iff done — accumulated sliced to target
  truncated?: boolean; // present iff done — union exceeded the target
}

// Fold one finished area's places into the running accumulation and decide
// whether the fan-out is complete. On the last area, slices the de-duplicated
// union down to the overall target (and flags truncation). Pure: the cron writes
// {results, area_index, status} straight from this.
export function ingestAreaResult(opts: {
  areaIndex: number; // the area that just finished (0-based)
  areaCount: number;
  accumulated: MapsPlace[]; // union from earlier areas
  incoming: MapsPlace[]; // this area's parsed places
  target: number;
}): IngestAreaResult {
  const { areaIndex, areaCount, accumulated, incoming, target } = opts;
  const merged = mergeMapsPlaces(accumulated, incoming);
  const nextAreaIndex = areaIndex + 1;
  const done = nextAreaIndex >= areaCount;
  if (!done) return { nextAreaIndex, accumulated: merged, done: false };

  const cap = Number.isFinite(target) ? Math.max(1, Math.round(target)) : merged.length;
  const finalResults = merged.slice(0, cap);
  return {
    nextAreaIndex,
    accumulated: finalResults,
    done: true,
    finalResults,
    truncated: merged.length > cap,
  };
}

type Rec = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Kebab-slug a Google category ("Dental clinic" → "dental-clinic") so it lines up
// with the decision-maker seniority-map category ids used by the naming phase.
function slugCategory(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Flatten + de-duplicate a dataset (by placeId). Permanently-closed businesses
// are dropped (never a lead; cheaper than the skipClosedPlaces filter charge).
// Rows with no placeId are dropped — they can't be dedupe-keyed.
export function parseMapsSearchResults(datasetItems: unknown[]): MapsPlace[] {
  const out: MapsPlace[] = [];
  const seen = new Set<string>();
  for (const raw of datasetItems as Rec[]) {
    if (!raw || typeof raw !== "object") continue;
    const placeId = str(raw.placeId);
    if (!placeId || seen.has(placeId)) continue;
    if (raw.permanentlyClosed === true) continue;
    seen.add(placeId);

    const website = str(raw.website);
    const catLabel = str(raw.categoryName);
    const loc = raw.location && typeof raw.location === "object" ? (raw.location as Rec) : null;
    const categories = Array.isArray(raw.categories)
      ? (raw.categories as unknown[]).map((c) => str(c)).filter((c): c is string => Boolean(c))
      : [];

    out.push({
      google_place_id: placeId,
      name: str(raw.title),
      category: catLabel ? slugCategory(catLabel) : null,
      category_label: catLabel,
      categories,
      website,
      company_domain: website ? normalizeDomain(website) : null,
      // phoneUnformatted is E.164; fall back to the display phone.
      phone: str(raw.phoneUnformatted) ?? str(raw.phone),
      full_address: str(raw.address),
      street: str(raw.street),
      city: str(raw.city),
      state: str(raw.state),
      postal_code: str(raw.postalCode),
      country_code: str(raw.countryCode),
      latitude: num(loc?.lat),
      longitude: num(loc?.lng),
      rating: num(raw.totalScore),
      reviews_count: num(raw.reviewsCount),
      maps_url: str(raw.url),
      temporarily_closed: raw.temporarilyClosed === true,
      // The actor flags a place that CAN be claimed (i.e. currently unclaimed);
      // invert to "claimed". Absent → unknown (null).
      claimed: typeof raw.claimThisBusiness === "boolean" ? !raw.claimThisBusiness : null,
    });
  }
  return out;
}
