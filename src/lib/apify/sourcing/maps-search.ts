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
