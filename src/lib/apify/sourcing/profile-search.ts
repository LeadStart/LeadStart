import type { LinkedInProspect } from "@/types/app";
import { extractProfileId, normalizeDomain } from "../domain";

// LinkedIn people-search sourcing — the top-of-funnel actor that finds NEW
// people by ICP filters (as opposed to the enrichment providers, which take
// people we already have and fill in their email/domain/activity).
//
// This module is pure: it builds the actor input from app-facing levers and
// flattens the actor's dataset into de-duplicated prospect rows. The DB/worker
// wiring (a linkedin_searches table + an async start-poll cron mirroring
// run-apify-enrichment) lives elsewhere and calls these two functions.
export const PROFILE_SEARCH_ACTOR_ID = "harvestapi~linkedin-profile-search";

// The actor's depth dial. Short = search pages only (cheapest, basic profile);
// Full = opens each profile; "Full + email" also runs an email search. Cost
// climbs with depth — we default to Short and let the enrichment waterfall find
// emails on only the people we keep. Short-mode price pinned on the first run.
export type ProfileSearchDepth = "short" | "full" | "full_email";
export const PROFILE_SEARCH_MODE_LABEL: Record<ProfileSearchDepth, string> = {
  short: "Short",
  full: "Full",
  full_email: "Full + email search",
};

// App-facing ICP levers. Values within a field are OR'd; fields are AND'd —
// the actor's own semantics. Empty/undefined fields are omitted from the input
// so an empty array never over-constrains the search.
export interface ProfileSearchLevers {
  query?: string;
  currentJobTitles?: string[];
  excludeCurrentJobTitles?: string[];
  pastJobTitles?: string[];
  locations?: string[];
  excludeLocations?: string[];
  currentCompanies?: string[];
  pastCompanies?: string[];
  companyHeadcount?: string[];
  industryIds?: string[];
  functionIds?: string[];
  seniorityLevelIds?: string[];
  schools?: string[];
  recentlyChangedJobs?: boolean;
  recentlyPostedOnLinkedIn?: boolean;
  // Auto query-segmentation: split one query into per-country/state/seniority
  // sub-queries so we pull past LinkedIn's ~1-page (~25) cookieless-search cap.
  autoSegment?: boolean;
}

const RESULTS_PER_PAGE = 25;
const MAX_ITEMS_CAP = 2500;
const MAX_PAGES = 100;

function cleanArr(v?: string[]): string[] | undefined {
  if (!v) return undefined;
  const out = Array.from(new Set(v.map((s) => s.trim()).filter(Boolean)));
  return out.length ? out : undefined;
}

// Maps ProfileSearchLevers keys to the actor's input keys (same names today, but
// kept explicit so a rename on either side is a one-line change).
const FIELD_MAP: Array<[keyof ProfileSearchLevers, string]> = [
  ["currentJobTitles", "currentJobTitles"],
  ["excludeCurrentJobTitles", "excludeCurrentJobTitles"],
  ["pastJobTitles", "pastJobTitles"],
  ["locations", "locations"],
  ["excludeLocations", "excludeLocations"],
  ["currentCompanies", "currentCompanies"],
  ["pastCompanies", "pastCompanies"],
  ["companyHeadcount", "companyHeadcount"],
  ["industryIds", "industryIds"],
  ["functionIds", "functionIds"],
  ["seniorityLevelIds", "seniorityLevelIds"],
  ["schools", "schools"],
];

export function buildProfileSearchInput(
  levers: ProfileSearchLevers,
  opts: { depth: ProfileSearchDepth; maxItems: number },
): Record<string, unknown> {
  const maxItems = Math.max(1, Math.min(MAX_ITEMS_CAP, Math.round(opts.maxItems)));
  const takePages = Math.max(1, Math.min(MAX_PAGES, Math.ceil(maxItems / RESULTS_PER_PAGE)));
  const input: Record<string, unknown> = {
    profileScraperMode: PROFILE_SEARCH_MODE_LABEL[opts.depth],
    maxItems,
    takePages,
  };
  const q = levers.query?.trim();
  if (q) input.searchQuery = q;
  for (const [leverKey, inputKey] of FIELD_MAP) {
    const arr = cleanArr(levers[leverKey] as string[] | undefined);
    if (arr) input[inputKey] = arr;
  }
  if (levers.recentlyChangedJobs) input.recentlyChangedJobs = true;
  if (levers.recentlyPostedOnLinkedIn) input.recentlyPostedOnLinkedIn = true;
  // Segmentation: takePages applies PER segment, maxItems caps the whole run —
  // so the actor sweeps country→state→seniority sub-queries until it has
  // maxItems unique profiles, bypassing the per-query wall. "default" levels =
  // country + state + seniority (industry stays off).
  if (levers.autoSegment) {
    input.autoQuerySegmentation = true;
    input.autoQuerySegmentationLevels = ["default"];
  }
  return input;
}

type Rec = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function pickLocation(rec: Rec): string | null {
  const loc = rec.location;
  if (typeof loc === "string") return str(loc);
  if (loc && typeof loc === "object") {
    const o = loc as Rec;
    return str(o.linkedinText) ?? str(o.text) ?? str(o.default) ?? null;
  }
  return null;
}

function pickCurrentPosition(rec: Rec): Rec | null {
  const arr =
    (Array.isArray(rec.currentPosition) && rec.currentPosition) ||
    (Array.isArray(rec.currentPositions) && rec.currentPositions) ||
    (Array.isArray(rec.experience) && rec.experience) ||
    [];
  return ((arr as Rec[])[0] as Rec | undefined) ?? null;
}

function pickEmail(rec: Rec): string | null {
  const direct = str(rec.email) ?? str(rec.workEmail) ?? str(rec.professionalEmail);
  if (direct) return direct;
  if (Array.isArray(rec.emails) && rec.emails.length > 0) {
    const first = rec.emails[0];
    if (typeof first === "string") return str(first);
    return str((first as Rec)?.email);
  }
  return null;
}

// Flatten + de-duplicate a dataset (by profile URN id, then by normalized
// LinkedIn URL). Rows with no LinkedIn identity are dropped — they can't be
// dedupe-keyed against contacts and aren't actionable.
export function parseProfileSearchResults(datasetItems: unknown[]): LinkedInProspect[] {
  const out: LinkedInProspect[] = [];
  const seen = new Set<string>();
  for (const raw of datasetItems as Rec[]) {
    if (!raw || typeof raw !== "object") continue;
    const linkedin_url = str(raw.linkedinUrl) ?? str(raw.url) ?? str(raw.publicUrl);
    const profile_id = str(raw.id) ?? extractProfileId(linkedin_url ?? undefined);
    const key = profile_id ?? (linkedin_url ? linkedin_url.toLowerCase() : null);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const pos = pickCurrentPosition(raw);
    const website = pos ? str(pos.companyWebsite) ?? str(pos.website) : null;
    out.push({
      profile_id,
      first_name: str(raw.firstName),
      last_name: str(raw.lastName),
      full_name: str(raw.name) ?? str(raw.fullName),
      headline: str(raw.headline),
      linkedin_url,
      location: pickLocation(raw),
      company_name: pos ? str(pos.companyName) : str(raw.companyName),
      company_linkedin_url: pos ? (str(pos.companyLinkedinUrl) ?? str(pos.companyUrl)) : null,
      company_domain: website ? normalizeDomain(website) : null,
      email: pickEmail(raw),
    });
  }
  return out;
}
