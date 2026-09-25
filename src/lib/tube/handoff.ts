// TuBe handoff: turn LeadStart's enriched Google-Maps firms into the exact upload
// sheet TuBe SEO's AI-visibility scan needs, so the scan asks the RIGHT question
// for every firm. The 2026-09-10 WA law-firm run went wrong at this seam: the
// sheet carried category labels ("Estate Planning") and no locked city, so 64 of
// 132 firms were asked the wrong question (wrong city/state, "businesses like
// this", malformed practice), and 4 scanned firms had nobody to email.
//
// Per firm we write the practice area the way a customer asks for it, the city +
// state that locks the question, the exact question itself (seed_query, which
// TuBe asks verbatim), the verified owner, and every name the firm goes by
// (aliases) so the scan can recognise the firm when the AI uses its legal name
// or the owner's name. Only firms we can actually email are exported; large
// firms, public bodies and nonprofits never reach the (paid) scan.
//
// Pure module: no I/O. Tested by scripts/test-tube-handoff.ts.

import { classifyEmailTier, type EmailTierInput } from "@/lib/enrichment/email-tier";

/** Upload columns, in order. TuBe maps them by header name: `markets` must come
 *  before `city` (its market matcher takes the first header containing "city"). */
export const TUBE_UPLOAD_COLUMNS = [
  "domain",
  "business_type",
  "seed_query",
  "markets",
  "company",
  "first_name",
  "last_name",
  "email",
  "city",
  "state",
  "aliases",
] as const;

export type TubeUploadRow = Record<(typeof TUBE_UPLOAD_COLUMNS)[number], string>;

export interface TubeContactInput extends EmailTierInput {
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  email_verification_status: string | null;
}

export interface TubeFirmInput {
  /** Google listing name. */
  placeName: string | null;
  /** Google categories in listing order (primary first). */
  categories: string[];
  city: string | null;
  /** "Washington" or "WA": both are accepted. */
  state: string | null;
  domain: string | null;
  /** The firm's enriched contact in LeadStart (null = not imported / enriched). */
  contact: TubeContactInput | null;
}

export type TubeSkipReason =
  | "not_in_contacts"
  | "no_owner_name"
  | "email_not_verified"
  | "no_website"
  | "no_city"
  | "large_firm"
  | "public_or_nonprofit"
  | "no_specific_practice"
  | "duplicate_website";

export const TUBE_SKIP_LABEL: Record<TubeSkipReason, string> = {
  not_in_contacts: "Not imported to Contacts yet",
  no_owner_name: "No owner name found",
  email_not_verified: "No verified personal email",
  no_website: "No website",
  no_city: "No city on the listing",
  large_firm: "Large firm (excluded)",
  public_or_nonprofit: "Public body or nonprofit (excluded)",
  no_specific_practice: "No specific practice area",
  duplicate_website: "Same website as another firm in the list",
};

// ── State ──────────────────────────────────────────────────────────────────
const STATE_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

/** "Washington" → "WA"; an existing 2-letter code is upper-cased; unknown → "". */
export function stateAbbrev(state: string | null | undefined): string {
  const s = (state ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_ABBR[s.toLowerCase()] ?? "";
}

// ── Practice area → customer phrasing ──────────────────────────────────────
// Google categories that say "a lawyer" without saying what kind. A question
// built on them ("best lawyers in Olympia") is too broad to be a credible hook.
const GENERIC_LAW = new Set([
  "attorney", "lawyer", "law firm", "legal services", "trial attorney", "civil law attorney",
  "general practice attorney", "mediation service", "attorney referral service",
  "paralegal services provider", "administrative attorney", "notary public",
]);

// Specific Google law categories → how a customer asks an assistant for them.
// Anything else shaped "<x> attorney" / "<x> lawyer" is pluralised as-is.
const LAW_PHRASE: Record<string, string> = {
  "personal injury attorney": "personal injury lawyers",
  "family law attorney": "family law attorneys",
  "divorce lawyer": "divorce lawyers",
  "divorce service": "divorce lawyers",
  "criminal justice attorney": "criminal defense attorneys",
  "dui attorney": "DUI attorneys",
  "estate planning attorney": "estate planning attorneys",
  "probate attorney": "probate attorneys",
  "estate litigation attorney": "estate litigation attorneys",
  "elder law attorney": "elder law attorneys",
  "real estate attorney": "real estate attorneys",
  "employment attorney": "employment lawyers",
  "labor relations attorney": "employment lawyers",
  "immigration attorney": "immigration lawyers",
  "immigration & naturalization service": "immigration lawyers",
  "bankruptcy attorney": "bankruptcy attorneys",
  "bankruptcy service": "bankruptcy attorneys",
  "business attorney": "business attorneys",
  "tax attorney": "tax attorneys",
  "patent attorney": "patent attorneys",
  "insurance attorney": "insurance claim lawyers",
  "social security attorney": "social security disability lawyers",
  "medical lawyer": "medical malpractice lawyers",
  "workers compensation attorney": "workers' compensation attorneys",
  "workers' compensation attorney": "workers' compensation attorneys",
};

// A generic-only listing: infer the practice from the firm's own name/website.
const NAME_PRACTICE: [RegExp, string][] = [
  [/real\s*estate|property/i, "real estate attorneys"],   // before "estate" (planning)
  [/injur|accident|crash|wreck/i, "personal injury lawyers"],
  [/divorce|family|custody/i, "family law attorneys"],
  [/criminal|defen[cs]e|\bdui\b|\bdwi\b/i, "criminal defense attorneys"],
  [/estate|wills?\b|trust|probate|elder/i, "estate planning attorneys"],
  [/immigra|visa\b|border/i, "immigration lawyers"],
  [/bankrupt/i, "bankruptcy attorneys"],
  [/employ|labor\b|workplace/i, "employment lawyers"],
  [/business|corporate|startup/i, "business attorneys"],
  [/patent|trademark/i, "intellectual property attorneys"],
];

const isLawCategory = (c: string) =>
  /attorney|lawyer|law firm|legal services|divorce service|bankruptcy service|naturalization/i.test(c);

function pluralize(phrase: string): string {
  const words = phrase.trim().split(/\s+/);
  const last = words.pop() ?? "";
  let plural: string;
  if (/[^aeiou]y$/i.test(last)) plural = last.slice(0, -1) + "ies";
  else if (/(s|x|z|ch|sh)$/i.test(last)) plural = last + "es";
  else plural = last + "s";
  return [...words, plural].join(" ");
}

export interface PracticeArea {
  /** Plural customer phrasing, e.g. "personal injury lawyers". */
  phrase: string;
  /** False when nothing more specific than "lawyers" could be determined. */
  specific: boolean;
  source: "category" | "name" | "generic";
}

/** The most specific practice the firm lists (listing order = its own priority),
 *  in customer words. Generic-only listings fall back to the firm's name/website,
 *  then to "lawyers" (flagged not specific). Non-law businesses pluralise their
 *  primary category ("Commercial cleaning service" → "commercial cleaning services"). */
export function practiceArea(categories: string[], name: string | null, domain: string | null): PracticeArea {
  const cats = (categories ?? []).map((c) => (c ?? "").trim()).filter(Boolean);
  const law = cats.filter(isLawCategory);
  if (law.length === 0 && cats.length > 0) {
    return { phrase: pluralize(cats[0].toLowerCase()), specific: true, source: "category" };
  }
  for (const c of law) {
    const key = c.toLowerCase();
    if (GENERIC_LAW.has(key)) continue;
    const mapped = LAW_PHRASE[key];
    if (mapped) return { phrase: mapped, specific: true, source: "category" };
    if (/(attorney|lawyer)$/i.test(key)) return { phrase: pluralize(key), specific: true, source: "category" };
  }
  const hay = `${name ?? ""} ${domain ?? ""}`;
  for (const [re, phrase] of NAME_PRACTICE) {
    if (re.test(hay)) return { phrase, specific: true, source: "name" };
  }
  // No categories at all: we can't even say it's a law firm, so no question.
  if (law.length === 0) return { phrase: "", specific: false, source: "generic" };
  return { phrase: "lawyers", specific: false, source: "generic" };
}

/** The exact recommendation question TuBe asks (verbatim, via seed_query). */
export function seedQuery(phrase: string, city: string, st: string): string {
  return `Who are the best ${phrase} in ${city}, ${st}?`;
}

// ── ICP exclusions (owner ruling 2026-09-24: large firms + nonprofits out) ──
const LARGE_FIRM =
  /fisherbroyles|davis wright tremaine|\bdwt\.com|fox rothschild|williams kastner|hagens berman|helsell fetterman|k&l gates|klgates|littler|foster garvey|perkins coie|lane powell|stoel rives|miller nash|jackson lewis|ogletree|gordon rees|wilson elser|lewis brisbois|morgan & morgan|forthepeople|dorsey|holland & knight|baker botts|norton rose|fish & richardson|haynes boone/i;
const PUBLIC_NAME =
  /legal aid|justice project|public defender|attorney general|prosecut|legal services of|volunteer attorneys|bar association|law center|columbia legal|northwest justice|department of|county of|city of/i;
const PUBLIC_CATEGORY =
  /non-profit|nonprofit|public defender|government office|courthouse|legal affairs bureau|lawyers association|veterans affairs|patent office|charity/i;
const FOR_PROFIT_SUFFIX = /\b(pllc|p\.?\s?s\.?|p\.?\s?c\.?|llp|llc|inc\.?|ltd\.?)(\b|$)/i;

export function icpExclusion(
  name: string | null,
  domain: string | null,
  categories: string[],
): "large_firm" | "public_or_nonprofit" | null {
  const n = name ?? "";
  const d = (domain ?? "").toLowerCase();
  if (LARGE_FIRM.test(`${n} ${d}`)) return "large_firm";
  if (PUBLIC_NAME.test(n) || (categories ?? []).some((c) => PUBLIC_CATEGORY.test(c))) return "public_or_nonprofit";
  if ((d.endsWith(".org") || d.endsWith(".gov")) && !FOR_PROFIT_SUFFIX.test(n)) return "public_or_nonprofit";
  return null;
}

// ── Names ───────────────────────────────────────────────────────────────────
/** Short firm name for copy: drop listing tails (" - Accident Attorneys", ": …",
 *  "(…)") and entity suffixes (PLLC, P.S., Inc, LLC, LLP, P.C.). */
export function shortCompany(name: string): string {
  const cleaned = name
    .replace(/\s*[-–—|:]\s.*$/, "")
    .replace(/\s*\(.*$/, "")
    .replace(/,?\s*\b(pllc|p\.?\s?s\.?|inc\.?|llc|llp|p\.?\s?c\.?|ltd\.?)(\b|$)\.?/gi, "")
    .replace(/[,\s]+$/, "")
    .trim();
  return cleaned || name.trim();
}

export function normDomain(d: string | null | undefined): string {
  return (d ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
}

/** Every name the firm goes by, so the scan recognises it when the AI uses the
 *  legal name ("Church Rietzke Johnson PLLC") or the owner ("Mc Bride Law Office").
 *  Names are shortened: a listing tail ("AEON Law - Patent, Trademark, and
 *  Copyright Attorneys") would hand the scan practice words that aren't identity. */
export function firmAliases(placeName: string | null, contact: TubeContactInput | null): string[] {
  const owner = [contact?.first_name, contact?.last_name].filter(Boolean).join(" ").trim();
  const out: string[] = [];
  for (const n of [placeName, contact?.company_name]) {
    const s = shortCompany((n ?? "").trim());
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  if (owner && !out.some((x) => x.toLowerCase() === owner.toLowerCase())) out.push(owner);
  return out;
}

// ── Build ───────────────────────────────────────────────────────────────────
export interface TubeSkip {
  name: string;
  domain: string;
  reason: TubeSkipReason;
}

export interface TubeHandoffResult {
  rows: TubeUploadRow[];
  skipped: TubeSkip[];
  /** Firms left out only for lacking a specific practice (opt-in to include). */
  genericCount: number;
}

/** One upload row per emailable firm (deduped by website), plus why every other
 *  firm was left out. `includeGeneric` also exports firms whose practice could
 *  not be narrowed past "lawyers" (they get the broad question). */
export function buildTubeHandoff(firms: TubeFirmInput[], opts: { includeGeneric?: boolean } = {}): TubeHandoffResult {
  const rows: TubeUploadRow[] = [];
  const skipped: TubeSkip[] = [];
  const seen = new Set<string>();
  let genericCount = 0;
  for (const f of firms) {
    const name = (f.placeName ?? f.contact?.company_name ?? "").trim();
    const domain = normDomain(f.domain);
    const skip = (reason: TubeSkipReason) => skipped.push({ name, domain, reason });
    if (!domain) { skip("no_website"); continue; }
    const excl = icpExclusion(name, domain, f.categories);
    if (excl) { skip(excl); continue; }
    const c = f.contact;
    if (!c) { skip("not_in_contacts"); continue; }
    if (!(c.first_name ?? "").trim()) { skip("no_owner_name"); continue; }
    if (classifyEmailTier(c) !== "person" || c.email_verification_status !== "ok") {
      skip("email_not_verified");
      continue;
    }
    const city = (f.city ?? "").trim();
    const st = stateAbbrev(f.state);
    if (!city || !st) { skip("no_city"); continue; }
    if (seen.has(domain)) { skip("duplicate_website"); continue; }
    const practice = practiceArea(f.categories, name, domain);
    if (!practice.specific) {
      if (practice.phrase) genericCount++;
      if (!opts.includeGeneric || !practice.phrase) { skip("no_specific_practice"); continue; }
    }
    seen.add(domain);
    rows.push({
      domain,
      business_type: practice.phrase,
      seed_query: seedQuery(practice.phrase, city, st),
      markets: `${city}, ${st}`,
      // The brand customers know (the Google listing), not the legal entity; the
      // legal name rides along in aliases.
      company: shortCompany(name),
      first_name: (c.first_name ?? "").trim(),
      last_name: (c.last_name ?? "").trim(),
      email: (c.email ?? "").trim(),
      city,
      state: st,
      aliases: firmAliases(f.placeName, c).join("; "),
    });
  }
  return { rows, skipped, genericCount };
}

/** Header + string rows for toCsv(). */
export function tubeUploadTable(rows: TubeUploadRow[]): { headers: string[]; rows: string[][] } {
  return {
    headers: [...TUBE_UPLOAD_COLUMNS],
    rows: rows.map((r) => TUBE_UPLOAD_COLUMNS.map((k) => r[k])),
  };
}
