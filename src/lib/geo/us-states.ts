// US states + DC: the ONE piece of geo reference that's small enough (51 rows)
// and needed synchronously (server-side, in the maps-search route's abbr→name
// normalization) to justify bundling. The big reference data (3k counties, ~19k
// cities) lives in the geo_places table and is served by the typeahead endpoint,
// never bundled. The compass Maps actor wants full state NAMES ("Texas", not
// "TX"); the picker sends full names, but the route normalizes defensively so a
// stray abbreviation still resolves.

export interface UsState {
  code: string; // USPS 2-letter, uppercase ("TX")
  name: string; // full name ("Texas")
  fips: string; // 2-digit state FIPS ("48")
}

export const US_STATES: readonly UsState[] = [
  { code: "AL", name: "Alabama", fips: "01" },
  { code: "AK", name: "Alaska", fips: "02" },
  { code: "AZ", name: "Arizona", fips: "04" },
  { code: "AR", name: "Arkansas", fips: "05" },
  { code: "CA", name: "California", fips: "06" },
  { code: "CO", name: "Colorado", fips: "08" },
  { code: "CT", name: "Connecticut", fips: "09" },
  { code: "DE", name: "Delaware", fips: "10" },
  { code: "DC", name: "District of Columbia", fips: "11" },
  { code: "FL", name: "Florida", fips: "12" },
  { code: "GA", name: "Georgia", fips: "13" },
  { code: "HI", name: "Hawaii", fips: "15" },
  { code: "ID", name: "Idaho", fips: "16" },
  { code: "IL", name: "Illinois", fips: "17" },
  { code: "IN", name: "Indiana", fips: "18" },
  { code: "IA", name: "Iowa", fips: "19" },
  { code: "KS", name: "Kansas", fips: "20" },
  { code: "KY", name: "Kentucky", fips: "21" },
  { code: "LA", name: "Louisiana", fips: "22" },
  { code: "ME", name: "Maine", fips: "23" },
  { code: "MD", name: "Maryland", fips: "24" },
  { code: "MA", name: "Massachusetts", fips: "25" },
  { code: "MI", name: "Michigan", fips: "26" },
  { code: "MN", name: "Minnesota", fips: "27" },
  { code: "MS", name: "Mississippi", fips: "28" },
  { code: "MO", name: "Missouri", fips: "29" },
  { code: "MT", name: "Montana", fips: "30" },
  { code: "NE", name: "Nebraska", fips: "31" },
  { code: "NV", name: "Nevada", fips: "32" },
  { code: "NH", name: "New Hampshire", fips: "33" },
  { code: "NJ", name: "New Jersey", fips: "34" },
  { code: "NM", name: "New Mexico", fips: "35" },
  { code: "NY", name: "New York", fips: "36" },
  { code: "NC", name: "North Carolina", fips: "37" },
  { code: "ND", name: "North Dakota", fips: "38" },
  { code: "OH", name: "Ohio", fips: "39" },
  { code: "OK", name: "Oklahoma", fips: "40" },
  { code: "OR", name: "Oregon", fips: "41" },
  { code: "PA", name: "Pennsylvania", fips: "42" },
  { code: "RI", name: "Rhode Island", fips: "44" },
  { code: "SC", name: "South Carolina", fips: "45" },
  { code: "SD", name: "South Dakota", fips: "46" },
  { code: "TN", name: "Tennessee", fips: "47" },
  { code: "TX", name: "Texas", fips: "48" },
  { code: "UT", name: "Utah", fips: "49" },
  { code: "VT", name: "Vermont", fips: "50" },
  { code: "VA", name: "Virginia", fips: "51" },
  { code: "WA", name: "Washington", fips: "53" },
  { code: "WV", name: "West Virginia", fips: "54" },
  { code: "WI", name: "Wisconsin", fips: "55" },
  { code: "WY", name: "Wyoming", fips: "56" },
];

const BY_CODE = new Map(US_STATES.map((s) => [s.code, s]));
const BY_NAME = new Map(US_STATES.map((s) => [s.name.toLowerCase(), s]));
const BY_FIPS = new Map(US_STATES.map((s) => [s.fips, s]));

// Full state name for a USPS abbreviation ("tx" → "Texas"), or null.
export function stateNameFromAbbr(abbr: string): string | null {
  return BY_CODE.get(abbr.trim().toUpperCase())?.name ?? null;
}

// USPS abbreviation for a full state name ("Texas" → "TX"), or null.
export function stateAbbrFromName(name: string): string | null {
  return BY_NAME.get(name.trim().toLowerCase())?.code ?? null;
}

// Full state name for a 2-digit FIPS ("48" → "Texas"), or null.
export function stateNameFromFips(fips: string): string | null {
  return BY_FIPS.get(fips.trim())?.name ?? null;
}

// Coerce EITHER an abbreviation OR a full name into the canonical full name.
// "TX" → "Texas"; "texas" → "Texas"; "Texas" → "Texas"; unknown → null. The
// maps-search route runs every area's state through this so the compass actor
// always receives a full name regardless of what the client sent.
export function normalizeStateName(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (t.length === 2) {
    const byAbbr = stateNameFromAbbr(t);
    if (byAbbr) return byAbbr;
  }
  return BY_NAME.get(t.toLowerCase())?.name ?? stateNameFromAbbr(t);
}
