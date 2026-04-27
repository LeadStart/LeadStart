import type { ScrapioPlace } from "./types";
import type { ScrapioBusiness } from "@/types/app";

// Flatten a raw Scrap.io place row into the table-friendly ScrapioBusiness
// shape that the UI renders and prospect_searches.results stores. Mirrors
// the transform in the Replit reference build (server/routes.ts:251-285)
// so the field set stays one-to-one with the original tool.
export function flattenPlace(place: ScrapioPlace): ScrapioBusiness {
  const mainTypes = (place.types ?? [])
    .filter((t) => t.is_main)
    .map((t) => t.type);
  const wd = place.website_data ?? {};
  const emails = (wd.emails ?? [])
    .map((e) => e.email)
    .filter(Boolean)
    .join(", ");

  return {
    name: place.name ?? "",
    google_id: place.google_id ?? "",
    types: mainTypes.join(", "),
    website: place.website ?? "",
    email: emails,
    phone: place.phone ?? "",
    phone_international: place.phone_international ?? "",
    full_address: place.location_full_address ?? "",
    street: place.location_street_1 ?? "",
    city: place.location_city ?? "",
    state: place.location_state ?? "",
    postal_code: place.location_postal_code ?? "",
    latitude: place.location_latitude ?? "",
    longitude: place.location_longitude ?? "",
    reviews_count: place.reviews_count ?? 0,
    reviews_rating: place.reviews_rating ?? "",
    is_closed: place.is_closed ?? false,
    link: place.link ?? "",
    facebook: (wd.facebook ?? []).join(", "),
    instagram: (wd.instagram ?? []).join(", "),
    linkedin: (wd.linkedin ?? []).join(", "),
    twitter: (wd.twitter ?? []).join(", "),
    youtube: (wd.youtube ?? []).join(", "),
  };
}
