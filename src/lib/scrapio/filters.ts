// UI-friendly filter keys → exact Scrap.io API parameter names.
// Sourced from the Replit Scraper-Tool reference build (server/routes.ts)
// which was hand-validated against https://apidoc.scrap.io/.

export const BOOLEAN_FILTER_MAP = {
  main_activity_only: "gmap_is_main_type",
  is_closed: "gmap_is_closed",
  has_website: "gmap_has_website",
  has_phone: "gmap_has_phone",
  has_email: "website_has_emails",
  has_facebook: "website_has_facebook",
  has_instagram: "website_has_instagram",
  has_youtube: "website_has_youtube",
  has_twitter: "website_has_twitter",
  has_linkedin: "website_has_linkedin",
  claimed: "gmap_is_claimed",
  has_contact_form: "website_has_contact_form",
  has_ad_pixel: "website_has_ad_pixel",
} as const;

export const NUMERIC_FILTER_MAP = {
  price_range: "gmap_price_range",
  rating_min: "gmap_rating_min",
  rating_max: "gmap_rating_max",
  reviews_min: "gmap_reviews_min",
  reviews_max: "gmap_reviews_max",
  photos_min: "gmap_photos_min",
  photos_max: "gmap_photos_max",
} as const;

export type ScrapioBooleanFilterKey = keyof typeof BOOLEAN_FILTER_MAP;
export type ScrapioNumericFilterKey = keyof typeof NUMERIC_FILTER_MAP;

// Loose input type — comes from the form on the Prospecting page where
// each control may be undefined (untouched), boolean, or a coerced string.
// Encoding all three avoids a parsing layer in the UI.
export type ScrapioFilters = Partial<{
  [K in ScrapioBooleanFilterKey]: boolean | "1" | "0" | "all" | null;
}> &
  Partial<{
    [K in ScrapioNumericFilterKey]: number | string | null;
  }>;

// Translates a UI filter object into the flat `{api_param: value}` map
// Scrap.io expects. Returns a fresh object — does not mutate `filters`.
//
// Boolean rules: the value coerces to 1 for true | 1 | "1", to 0 for
// false | 0 | "0", and is dropped for undefined | null | "" | "all".
// Numeric rules: parsed via Number; NaN values are silently dropped so a
// bad form input doesn't poison the request (matches Replit behavior).
export function buildFilterParams(
  filters: ScrapioFilters | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!filters) return out;

  for (const [uiKey, apiParam] of Object.entries(BOOLEAN_FILTER_MAP)) {
    const v = (filters as Record<string, unknown>)[uiKey];
    if (v === undefined || v === null || v === "" || v === "all") continue;
    if (v === true || v === 1 || v === "1") out[apiParam] = 1;
    else if (v === false || v === 0 || v === "0") out[apiParam] = 0;
  }

  for (const [uiKey, apiParam] of Object.entries(NUMERIC_FILTER_MAP)) {
    const v = (filters as Record<string, unknown>)[uiKey];
    if (v === undefined || v === null || v === "" || v === "all") continue;
    const n = Number(v);
    if (!Number.isNaN(n)) out[apiParam] = n;
  }

  return out;
}
