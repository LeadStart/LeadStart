// Scrap.io access for the pipeline's pull (steps 1-2). The org's key is read
// from organizations.scrapio_api_key inside this process and never printed.
//
// Owner rules, from the 2026-09-26 lock (see references/lessons.md #7):
//   - stop on the FIRST 403/429: never retry, never read an error as 0;
//   - search only the metros in the run's brief, never a whole state;
//   - every search and every credit spend is announced with its count first.
// Verified API behaviour (2026-09-24): types[] carries up to 5 categories; a
// skip_data=1 search is a free count (it still uses the fair-use search
// quota); 202 is success (data still returned while an area refreshes); firms
// on our block list come back as free stubs {blacklisted:true}; a re-pull of a
// place charged in the last 30 days is free.
import { ORG_ID, StopError, basename, rest } from "./lib.mjs";

export const BLOCKLIST = `leadstart-${ORG_ID}`;

// ── Search ceilings (owner, 2026-09-29: "ENSURE THOSE CRAZY # of searches NEVER HAPPENS AGAIN") ──
// Throwaway count scripts sent ~1,800 searches in three days and locked the
// account on 2026-09-26. Now every Scrap.io search (/gmap/*: pull pages, free
// counts, lookups) first claims a slot in LeadStart's shared search log
// (migration 00135, claim_scrapio_search), which refuses past 150 in 24 hours,
// 400 in 7 days and 1,000 in 30 days for the organization: this skill, the app
// and every computer share the same log. On top, one script run sends at most
// RUN_LIMIT. If the log can't be reached, nothing is sent. The database
// ceilings change only through a new migration, with the owner's go.
export const RUN_LIMIT = 100;
const SOURCE = `tube-pipeline:${basename(process.argv[1] ?? "script")}`;
// The run each search belongs to (from --run), so assess.mjs counts exactly this run's searches.
const RUN = (() => {
  const i = process.argv.indexOf("--run");
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
})();
let thisRun = 0;

export const fmtBudget = (b) =>
  `${b.day}/${b.limits.day} in 24 hours · ${b.week}/${b.limits.week} in 7 days · ${b.month}/${b.limits.month} in 30 days`;

/** Searches used and left: the organization's windows, capped by this run's limit. Read-only. */
export async function searchBudget() {
  let b;
  try {
    b = await rest("rpc/scrapio_search_budget", { method: "POST", body: JSON.stringify({ p_organization_id: ORG_ID }) });
  } catch (e) {
    throw new StopError(`Can't read the Scrap.io search log, so no search is sent (${e.message}).`);
  }
  return { ...b, run: thisRun, left: Math.max(0, Math.min(b.left, RUN_LIMIT - thisRun)) };
}

/** Refuse (StopError) unless `n` more searches fit every ceiling. */
export async function assertSearchBudget(n, what) {
  const b = await searchBudget();
  if (n > b.left) {
    throw new StopError(
      `REFUSED before any search: ${what} needs ${n} Scrap.io searches and only ${b.left} fit ` +
        `(${fmtBudget(b)}; at most ${RUN_LIMIT} per run). Narrow the metros, or wait for the window to free up.`,
    );
  }
  return b;
}

async function claimSearch(path, pairs) {
  if (thisRun >= RUN_LIMIT) throw new StopError(`REFUSED: this run already sent ${thisRun} Scrap.io searches (at most ${RUN_LIMIT} per run).`);
  const detail = {
    run: RUN,
    city: pairs.find(([k]) => k === "city")?.[1] ?? null,
    types: pairs.filter(([k]) => k === "types[]").map(([, v]) => v),
    kind: pairs.some(([k, v]) => k === "skip_data" && v === "1") ? "count" : pairs.some(([k]) => k === "cursor") ? "page+" : "page",
  };
  let b;
  try {
    b = await rest("rpc/claim_scrapio_search", {
      method: "POST",
      body: JSON.stringify({ p_organization_id: ORG_ID, p_endpoint: path, p_source: SOURCE, p_detail: detail }),
    });
  } catch (e) {
    throw new StopError(`REFUSED: couldn't log the search in the Scrap.io search log, so it wasn't sent (${e.message}).`);
  }
  if (!b?.ok) throw new StopError(`REFUSED: the Scrap.io search limit is reached (${fmtBudget(b)}). Nothing was sent.`);
  thisRun++;
}
// The 15 practice types, in the groups the owner chose from (2026-09-25).
export const GROUP_TYPES = {
  A: ["attorney", "law-firm", "personal-injury-attorney", "family-law-attorney", "criminal-justice-attorney"],
  B: ["estate-planning-attorney", "divorce-lawyer", "real-estate-attorney", "bankruptcy-attorney", "immigration-attorney"],
  C: ["elder-law-attorney", "employment-attorney", "social-security-attorney", "insurance-attorney", "medical-lawyer"],
};

let KEY = null;
async function apiKey() {
  if (KEY) return KEY;
  const [org] = await rest(`organizations?select=scrapio_api_key&id=eq.${ORG_ID}`);
  KEY = org?.scrapio_api_key ?? null;
  if (!KEY) throw new Error("No Scrap.io API key on the organization (Settings → API).");
  return KEY;
}

/** One Scrap.io call. 200/202 = success; 403/429 stop the whole script. Every
 *  /gmap/ search claims a slot in the search log first, and is never retried. */
export async function sc(path, pairs = [], init = {}) {
  if (path.startsWith("/gmap/")) await claimSearch(path, pairs);
  const qs = new URLSearchParams(pairs).toString();
  const res = await fetch(`https://scrap.io/api/v1${path}${qs ? `?${qs}` : ""}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await apiKey()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 800);
  }
  if (res.status === 403 || res.status === 429) {
    const locked = /fair.?use/i.test(text);
    throw new StopError(
      `STOPPED: Scrap.io answered HTTP ${res.status} on ${path}${locked ? " (fair-use search quota: the account is locked until Scrap.io support unlocks it)" : ""}. ` +
        `Nothing was retried. Body: ${JSON.stringify(body).slice(0, 240)}`,
    );
  }
  return { status: res.status, body };
}

/** Export credits: { consumed, remaining }. Throws unless Scrap.io answers cleanly. */
export async function credits() {
  const r = await sc("/subscription");
  const c = r.body?.subscription?.features?.EXPORT_CREDITS;
  if (r.status !== 200 || !c) throw new Error(`Couldn't read Scrap.io credits: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return { consumed: Number(c.consumed), remaining: Number(c.remaining) };
}

/** Add place ids or firm domains to our block list, 100 per call. Returns how many were added. */
export async function pushBlock(type, ids) {
  let added = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const r = await sc(`/blacklists/${encodeURIComponent(BLOCKLIST)}`, [], { method: "POST", body: JSON.stringify({ type, data: part }) });
    if (r.status < 200 || r.status >= 300) throw new Error(`block list ${type} push failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    added += part.length;
    await new Promise((res) => setTimeout(res, 600));
  }
  return added;
}

/** The search filters for one city and a set of practice types, from the brief. */
export function searchPairs({ state, city, types, minReviews, website = true, openOnly = true }) {
  return [
    ["country_code", "US"],
    ["admin1_code", state],
    ...(website ? [["gmap_has_website", "1"]] : []),
    ...(openOnly ? [["gmap_is_closed", "0"]] : []),
    ["city", city],
    ...types.map((t) => ["types[]", t]),
    ["gmap_reviews_count_gte", String(minReviews)],
    ["blacklists[]", BLOCKLIST],
  ];
}

// Hosts that are never a firm's own website (so never a block-list domain).
const PLATFORM = new Set(["facebook.com", "m.facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "google.com",
  "sites.google.com", "business.site", "g.page", "maps.google.com", "wixsite.com", "squarespace.com", "godaddysites.com", "weebly.com",
  "wordpress.com", "blogspot.com", "square.site", "carrd.co", "linktr.ee", "yelp.com", "avvo.com", "findlaw.com", "justia.com",
  "lawyers.com", "martindale.com", "superlawyers.com", "nolo.com", "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com"]);
export function webHost(u) {
  try {
    return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
export const isFirmDomain = (d) => Boolean(d) && !PLATFORM.has(d) && ![...PLATFORM].some((p) => d.endsWith(`.${p}`));

/** The practice types a brief asks for: explicit types win, else the groups. */
export function briefTypes(brief) {
  const groups = brief?.practice?.groups ?? ["A", "B", "C"];
  const bad = groups.filter((g) => !GROUP_TYPES[g]);
  if (bad.length) throw new Error(`brief.practice.groups has unknown group(s) ${bad.join(", ")} (known: A, B, C)`);
  return Object.fromEntries(groups.map((g) => [g, GROUP_TYPES[g]]));
}
