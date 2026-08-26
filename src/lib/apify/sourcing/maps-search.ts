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

// App-facing levers. searchTerms are OR'd across searches; a location is required
// (free text "City, ST" or "State"). websiteFilter/minStars/categoryFilterWords
// each add a per-place filter charge, so they're sent ONLY when explicitly set.
export interface MapsSearchLevers {
  searchTerms?: string[];
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

export function buildMapsSearchInput(
  levers: MapsSearchLevers,
  opts: { maxItems: number },
): Record<string, unknown> {
  const terms = cleanArr(levers.searchTerms) ?? [];
  const location = levers.locationQuery?.trim() ?? "";
  const cap = Math.max(1, Math.min(MAX_ITEMS_CAP, Math.round(opts.maxItems)));
  const perSearch = Math.max(1, Math.min(PER_SEARCH_CAP, Math.ceil(cap / Math.max(1, terms.length))));

  const input: Record<string, unknown> = {
    searchStringsArray: terms,
    locationQuery: location,
    maxCrawledPlacesPerSearch: perSearch,
    language: "en",
    // Detail pages + the actor's own contacts enrichment stay OFF — we enrich
    // domains ourselves (site_scrape ~$0.003 + pattern_mv), far cheaper than the
    // actor's per-place add-on events.
    scrapePlaceDetailPage: false,
    scrapeContacts: false,
    maximumLeadsEnrichmentRecords: 0,
  };

  // Each filter option adds a per-place `filter-applied` charge
  // (billed = places × filter_price × #filters), so send them ONLY when the user
  // asked. Closed places are dropped for free in parseMapsSearchResults instead
  // of via skipClosedPlaces (which would bill a filter on every place).
  if (levers.websiteFilter === "with") input.website = "withWebsite";
  else if (levers.websiteFilter === "without") input.website = "withoutWebsite";
  const minStars = levers.minStars?.trim();
  if (minStars) input.placeMinimumStars = minStars;
  const cats = cleanArr(levers.categoryFilterWords);
  if (cats) input.categoryFilterWords = cats;

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
