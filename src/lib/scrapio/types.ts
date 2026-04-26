// Raw Scrap.io API response shapes. Kept thin — only fields LeadStart
// reads. Anything else is left as `unknown` so an upstream change doesn't
// silently drift from our types.

export interface ScrapioSubscription {
  // Field shape isn't formally documented by Scrap.io. Treat the response
  // as opaque-ish — surface plan/credit info to the UI when present, but
  // don't depend on a particular shape inside business logic.
  plan?: string;
  credits?: number;
  credits_remaining?: number;
  credits_used?: number;
  reset_date?: string;
  [key: string]: unknown;
}

export interface ScrapioLocation {
  id: string;
  text: string;
  parent_admin1?: string;
}

export type ScrapioLocationType = "admin1" | "admin2" | "city";

export interface ScrapioCategory {
  id: string;
  text: string;
}

// Raw Scrap.io place row from /gmap/search. We flatten this into
// ScrapioBusiness (in src/types/app.ts) before storing or returning to
// the client.
export interface ScrapioPlace {
  name?: string;
  google_id?: string;
  types?: Array<{ type: string; is_main?: boolean }>;
  website?: string;
  phone?: string;
  phone_international?: string;
  location_full_address?: string;
  location_street_1?: string;
  location_city?: string;
  location_state?: string;
  location_postal_code?: string;
  location_latitude?: number | string;
  location_longitude?: number | string;
  reviews_count?: number;
  reviews_rating?: number | string;
  is_closed?: boolean;
  link?: string;
  website_data?: {
    emails?: Array<{ email: string }>;
    facebook?: string[];
    instagram?: string[];
    linkedin?: string[];
    twitter?: string[];
    youtube?: string[];
  };
}

export interface ScrapioSearchResponse {
  data?: ScrapioPlace[];
  meta?: {
    total?: number;
    next_cursor?: string | null;
  };
}

// Inputs to ScrapioClient.search(). admin1_code is the state (e.g. "TX");
// admin2_code is the county; city narrows further. type is the category id.
export interface ScrapioSearchParams {
  type: string;
  admin1_code: string;
  admin2_code?: string;
  city?: string;
  per_page?: number;
  cursor?: string;
  filters?: Record<string, unknown>;
}
