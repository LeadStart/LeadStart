// Column registry for the Google-Maps prospecting CSV export. Each column is
// defined once here (key, label, group, default state, and how to read its value
// off a place / its enriched lead) so the picker UI and the row builder stay in
// sync and no export ever hardcodes a column list again.

import type { MapsPlace, MapsLead } from "@/types/app";

export type MapsExportGroup = "firm" | "contact";

export interface MapsExportColumn {
  key: string;
  label: string;
  group: MapsExportGroup;
  /** Checked by default in the picker. Domain is on so a list can't ship without it. */
  defaultOn: boolean;
  /** Read the cell value. `lead` is null for places with no enriched people. */
  get: (place: MapsPlace, lead: MapsLead | null) => string;
}

const s = (v: unknown): string => (v == null ? "" : String(v));

// Order here is the order columns appear in the exported file.
export const MAPS_EXPORT_COLUMNS: MapsExportColumn[] = [
  // Firm / place
  { key: "firm", label: "Firm", group: "firm", defaultOn: true, get: (p) => s(p.name) },
  { key: "domain", label: "Domain", group: "firm", defaultOn: true, get: (p) => s(p.company_domain) },
  { key: "website", label: "Website", group: "firm", defaultOn: true, get: (p) => s(p.website) },
  { key: "city", label: "City", group: "firm", defaultOn: true, get: (p) => s(p.city) },
  { key: "state", label: "State", group: "firm", defaultOn: true, get: (p) => s(p.state) },
  { key: "phone", label: "Phone", group: "firm", defaultOn: true, get: (p) => s(p.phone) },
  { key: "categories", label: "Google Categories", group: "firm", defaultOn: true, get: (p) => (p.categories ?? []).join(" | ") },
  { key: "category", label: "Primary Category", group: "firm", defaultOn: false, get: (p) => s(p.category_label ?? p.category) },
  { key: "rating", label: "Rating", group: "firm", defaultOn: false, get: (p) => s(p.rating) },
  { key: "reviews", label: "Reviews", group: "firm", defaultOn: false, get: (p) => s(p.reviews_count) },
  { key: "full_address", label: "Full Address", group: "firm", defaultOn: false, get: (p) => s(p.full_address) },
  { key: "maps_url", label: "Google Maps URL", group: "firm", defaultOn: false, get: (p) => s(p.maps_url) },
  // Contact / enriched lead (present only when the LinkedIn-people add-on ran)
  { key: "first_name", label: "First Name", group: "contact", defaultOn: true, get: (_p, l) => s(l?.first_name) },
  { key: "last_name", label: "Last Name", group: "contact", defaultOn: true, get: (_p, l) => s(l?.last_name) },
  { key: "title", label: "Title", group: "contact", defaultOn: true, get: (_p, l) => s(l?.title) },
  { key: "email", label: "Email", group: "contact", defaultOn: true, get: (_p, l) => s(l?.email) },
  { key: "seniority", label: "Seniority", group: "contact", defaultOn: false, get: (_p, l) => s(l?.seniority) },
  { key: "linkedin", label: "LinkedIn", group: "contact", defaultOn: false, get: (_p, l) => s(l?.linkedin_url) },
];

export const DEFAULT_MAPS_EXPORT_KEYS: string[] = MAPS_EXPORT_COLUMNS.filter((c) => c.defaultOn).map((c) => c.key);

/**
 * Flatten places into CSV header + rows for the chosen column keys (in registry
 * order). One row per enriched lead when a place has them AND a contact column is
 * selected; otherwise one row per place, so firms are never dropped and firm-only
 * exports don't duplicate rows per lead.
 */
export function buildMapsCsvRows(
  places: MapsPlace[],
  keys: string[],
): { headers: string[]; rows: string[][] } {
  const cols = MAPS_EXPORT_COLUMNS.filter((c) => keys.includes(c.key));
  const headers = cols.map((c) => c.label);
  const expandLeads = cols.some((c) => c.group === "contact");
  const rows: string[][] = [];
  for (const place of places) {
    const leads: (MapsLead | null)[] =
      expandLeads && place.leads && place.leads.length > 0 ? place.leads : [null];
    for (const lead of leads) rows.push(cols.map((c) => c.get(place, lead)));
  }
  return { headers, rows };
}
