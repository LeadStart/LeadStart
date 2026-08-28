// Name→domain discovery — the fallback for contacts whose employer has no
// LinkedIn company page (small local businesses). Given a company NAME (+ the
// contact's location for disambiguation), ask a web-search LLM for the company's
// official website, then STRICTLY validate the answer before we trust it — a
// wrong domain would feed the pattern-guesser and produce an email at the wrong
// company.
//
// Everything here is pure except the runner, which takes injected network
// functions (the LLM call + a homepage fetch) so the validation logic is
// unit-testable with no network — mirrors pattern-mv.ts. All DB writes + key/
// cost handling live in the cron caller (run-apify-enrichment).

import { normalizeDomain, normalizeCompanyName } from "../apify/domain";

// ---------------------------------------------------------------- types

export interface DiscoveryItem {
  id: string;
  companyName: string;
  location: string | null;
}

export interface DomainLookupAnswer {
  domain: string | null;
  confidence: "high" | "medium" | "low" | null;
  source_url: string | null;
  evidence: string | null;
}

export type PreValidation =
  | { kind: "accept"; domain: string; note: string }
  | { kind: "needs_homepage"; domain: string; reason: string }
  | { kind: "reject"; reason: string };

export type HomepageValidation =
  | { kind: "accept"; domain: string; note: string }
  | { kind: "reject"; reason: string };

export type DomainDiscoveryOutcome =
  | { kind: "found"; domain: string; note: string; cost: number }
  | { kind: "not_found"; note: string; cost: number }
  | { kind: "inconclusive"; note: string; cost: number };

export type LlmSearchFn = (
  prompt: string,
) => Promise<{ text: string; citations: string[]; cost: number }>;
export type FetchPageFn = (url: string) => Promise<string>;

// ---------------------------------------------------------------- token helpers

// Words we never treat as a business's distinctive identity — an industry/
// descriptor token shared by thousands of companies. (normalizeCompanyName
// already drops legal suffixes like LLC/Inc/Group/Company, so those aren't here.)
const GENERIC_NAME_TOKENS = new Set([
  "cleaning", "janitorial", "services", "service", "solutions", "commercial",
  "professional", "pro", "plus", "quality", "building", "buildings",
  "maintenance", "facility", "facilities", "management", "enterprises",
  "systems", "contracting", "contractors", "construction", "consulting",
  "industries", "industrial", "national", "american", "usa", "inc", "llc",
]);

const STOPWORDS = new Set(["the", "and", "of", "a", "an", "&"]);

// Split a company name into identity tokens. `all` = every meaningful word;
// `distinctive` = the non-generic subset that actually identifies the business.
function companyTokens(companyName: string): { all: string[]; distinctive: string[] } {
  const norm = normalizeCompanyName(companyName); // lowercased, punctuation + legal suffixes stripped
  const all = norm.split(/\s+/).filter((t) => t && !STOPWORDS.has(t));
  const distinctive = all.filter((t) => !GENERIC_NAME_TOKENS.has(t));
  return { all, distinctive };
}

// First label of a normalized domain, alphanumerics only ("acme-clean.co" → "acmeclean").
function domainLabel(domain: string): string {
  const norm = normalizeDomain(domain);
  if (!norm) return "";
  return norm.split(".")[0].replace(/[^a-z0-9]/g, "");
}

// Directory / data-broker / review hosts that a web search often returns instead
// of the company's own site. Kept LOCAL (not added to the shared REJECTED_HOSTS,
// which also gates scraped company websites at sourcing).
export const DISCOVERY_REJECTED_HOSTS: readonly string[] = [
  "yellowpages.com", "bbb.org", "mapquest.com", "angi.com", "angieslist.com",
  "homeadvisor.com", "thumbtack.com", "houzz.com", "porch.com", "manta.com",
  "chamberofcommerce.com", "dnb.com", "zoominfo.com", "apollo.io", "signalhire.com",
  "kompass.com", "yell.com", "foursquare.com", "nextdoor.com", "buzzfile.com",
  "opencorporates.com", "bizapedia.com", "rocketreach.co", "leadiq.com",
  "crunchbase.com", "glassdoor.com", "indeed.com", "yelp.com", "trustpilot.com",
];

// ---------------------------------------------------------------- pure functions

// Best-effort location string for disambiguation. LinkedIn-sourced contacts
// keep the person's free-text location under enrichment_data.source_row.location;
// Scrap.io-sourced contacts store city/state at the enrichment_data root; the
// profiles phase leaves a fallback under enrichment.profile.location.
export function extractContactLocation(enrichmentData: unknown): string | null {
  if (!enrichmentData || typeof enrichmentData !== "object") return null;
  const ed = enrichmentData as Record<string, unknown>;

  const sourceRow = ed.source_row as Record<string, unknown> | undefined;
  if (sourceRow && typeof sourceRow.location === "string" && sourceRow.location.trim()) {
    return sourceRow.location.trim();
  }

  const city = typeof ed.city === "string" ? ed.city.trim() : "";
  const state = typeof ed.state === "string" ? ed.state.trim() : "";
  const parts = [city, state].filter(Boolean);
  if (parts.length) return parts.join(", ");

  const enrichment = ed.enrichment as Record<string, unknown> | undefined;
  const profile = enrichment?.profile as Record<string, unknown> | undefined;
  if (profile && typeof profile.location === "string" && profile.location.trim()) {
    return profile.location.trim();
  }
  return null;
}

export function buildDomainDiscoveryPrompt(companyName: string, location: string | null): string {
  const locLine = location ? `\nLocation: ${location}` : "";
  return `Find the official website of this business.

Business: ${companyName}${locLine}

RULES:
- Return the business's OWN website only — NOT LinkedIn, Facebook, Instagram, Yelp,
  Google Maps, Yellow Pages, BBB, Thumbtack, Angi, directories, aggregators, review
  sites, or news articles.
- This is likely a small local business. Prefer a site whose name clearly matches the business name${location ? " and its location" : ""}.
- If it is a franchise location, return that location's own site if one exists, otherwise the brand's site.
- "source_url" must be a real page you actually found that shows this website belongs to this business.
- Set "confidence" to "high" only if the site clearly names this business${location ? " and its location" : ""}.
- Do NOT guess or construct a domain from the business name. Only return a website you actually found.

Return ONLY valid JSON, no markdown:
{"domain": "example.com", "confidence": "high", "source_url": "https://...", "evidence": "one short sentence"}

If you cannot find the business's own website, return:
{"domain": null, "confidence": null, "source_url": null, "evidence": "not found"}`;
}

// Extract the first JSON object from an LLM response (layer2 style) and coerce
// its fields. Returns null when there's no parseable object at all.
export function parseDomainLookupAnswer(text: string): DomainLookupAnswer | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const domain = typeof o.domain === "string" && o.domain.trim() ? o.domain.trim() : null;
  const confRaw = typeof o.confidence === "string" ? o.confidence.toLowerCase() : null;
  const confidence =
    confRaw === "high" || confRaw === "medium" || confRaw === "low" ? confRaw : null;
  const source_url = typeof o.source_url === "string" && o.source_url.trim() ? o.source_url.trim() : null;
  const evidence = typeof o.evidence === "string" && o.evidence.trim() ? o.evidence.trim() : null;
  return { domain, confidence, source_url, evidence };
}

// Does the company name provably relate to the domain? Strict: a distinctive
// name token in the domain label, an acronym, or the full-name concatenation.
export function nameTokenMatch(companyName: string, domain: string): boolean {
  const label = domainLabel(domain);
  if (!label) return false;
  const { all, distinctive } = companyTokens(companyName);
  if (all.length === 0) return false;

  // (a) a distinctive token appears in the label. Require ≥4 chars, or ≥3 when no
  //     distinctive token is that long (short-but-real names like "AG Pro").
  const maxLen = distinctive.reduce((m, t) => Math.max(m, t.length), 0);
  const minTokenLen = maxLen >= 4 ? 4 : 3;
  for (const t of distinctive) {
    if (t.length >= minTokenLen && label.includes(t)) return true;
  }
  // (b) acronym of all tokens (≥3 tokens) equals or prefixes the label.
  if (all.length >= 3) {
    const acronym = all.map((t) => t[0]).join("");
    if (acronym.length >= 3 && (label === acronym || label.startsWith(acronym))) return true;
  }
  // (c) full-token concatenation equals the label.
  const concat = all.join("");
  if (concat && label === concat) return true;
  return false;
}

// A citation confirms a domain when the LLM's own source_url (or any grounding
// citation) is on that domain — a made-up domain won't appear in real citations.
function citationConfirms(domain: string, answer: DomainLookupAnswer, citations: string[]): boolean {
  const target = normalizeDomain(domain);
  if (!target) return false;
  if (answer.source_url && normalizeDomain(answer.source_url) === target) return true;
  for (const c of citations) {
    if (normalizeDomain(c) === target) return true;
  }
  return false;
}

// First-pass decision from the LLM answer alone (no network). accept =
// name-match AND source-confirmed; needs_homepage = plausible but unproven;
// reject = junk/aggregator/unusable.
export function preValidateCandidate(
  companyName: string,
  answer: DomainLookupAnswer,
  citations: string[],
): PreValidation {
  if (!answer.domain) return { kind: "reject", reason: "no domain in answer" };
  const norm = normalizeDomain(answer.domain);
  if (!norm) return { kind: "reject", reason: `not a usable company domain (${answer.domain})` };
  if (DISCOVERY_REJECTED_HOSTS.some((h) => norm === h || norm.endsWith("." + h))) {
    return { kind: "reject", reason: `directory/aggregator (${norm})` };
  }
  const nameMatches = nameTokenMatch(companyName, norm);
  const confirmed = citationConfirms(norm, answer, citations);
  if (nameMatches && confirmed) {
    return { kind: "accept", domain: norm, note: "name match, source-confirmed" };
  }
  const reason =
    !nameMatches && !confirmed
      ? "no name match, no citation confirmation"
      : !nameMatches
        ? "citation-confirmed but name mismatch"
        : "name match but no citation confirmation";
  return { kind: "needs_homepage", domain: norm, reason };
}

// Live confirmation: the homepage text must mention the company. Empty text
// (blocked / timed out / parked domain / SSRF-refused) is a STRICT reject — we'd
// rather miss a real domain than write a wrong one.
export function confirmViaHomepage(
  companyName: string,
  domain: string,
  homepageText: string,
): HomepageValidation {
  if (!homepageText || !homepageText.trim()) {
    return { kind: "reject", reason: "unconfirmed — homepage unreachable" };
  }
  const hay = homepageText.toLowerCase();
  const { all, distinctive } = companyTokens(companyName);
  const tokens = distinctive.length ? distinctive : all;
  const hit = tokens.some((t) => t.length >= 3 && hay.includes(t));
  return hit
    ? { kind: "accept", domain, note: "homepage-confirmed" }
    : { kind: "reject", reason: "homepage does not mention the company" };
}

// ---------------------------------------------------------------- runner

async function discoverOne(
  item: DiscoveryItem,
  llm: LlmSearchFn,
  fetchHomepage: FetchPageFn,
  providerLabel: string,
): Promise<DomainDiscoveryOutcome> {
  const prompt = buildDomainDiscoveryPrompt(item.companyName, item.location);
  let text: string;
  let citations: string[];
  let cost: number;
  try {
    const r = await llm(prompt);
    text = r.text;
    citations = r.citations;
    cost = r.cost;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: "inconclusive", note: `web lookup error: ${msg.slice(0, 160)}`, cost: 0 };
  }

  const answer = parseDomainLookupAnswer(text);
  if (!answer) return { kind: "inconclusive", note: "web lookup returned unparseable output", cost };
  if (!answer.domain) return { kind: "not_found", note: "web lookup found no website", cost };

  const pre = preValidateCandidate(item.companyName, answer, citations);
  if (pre.kind === "reject") return { kind: "not_found", note: `rejected: ${pre.reason}`, cost };
  if (pre.kind === "accept") {
    return { kind: "found", domain: pre.domain, note: `discovered via ${providerLabel} — ${pre.note}`, cost };
  }

  // needs_homepage → live confirmation
  const homepageText = await fetchHomepage(`https://${pre.domain}`);
  const conf = confirmViaHomepage(item.companyName, pre.domain, homepageText);
  return conf.kind === "accept"
    ? { kind: "found", domain: pre.domain, note: `discovered via ${providerLabel} — ${conf.note}`, cost }
    : { kind: "not_found", note: `rejected: ${conf.reason}`, cost };
}

export interface RunDomainDiscoveryOpts {
  deadlineMs: number;
  concurrency: number;
  providerLabel: string; // "sonar" (Perplexity only)
}

// Discover domains for a batch. One paid LLM call per unique (name + location)
// group; the outcome fans out to every member with the cost split evenly.
// Deadline-bounded: groups not reached are absent from the map (caller leaves
// those items pending for the next tick). Never throws for a per-call failure —
// those surface as `inconclusive`.
export async function runDomainDiscovery(
  items: DiscoveryItem[],
  llm: LlmSearchFn,
  fetchHomepage: FetchPageFn,
  opts: RunDomainDiscoveryOpts,
): Promise<Map<string, DomainDiscoveryOutcome>> {
  const results = new Map<string, DomainDiscoveryOutcome>();

  const groups = new Map<string, DiscoveryItem[]>();
  for (const it of items) {
    const key = `${normalizeCompanyName(it.companyName)}|${(it.location ?? "").toLowerCase().trim()}`;
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  const groupList = Array.from(groups.values());

  const conc = Math.max(1, Math.min(opts.concurrency, groupList.length || 1));
  let idx = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() > opts.deadlineMs) return;
      const i = idx++;
      if (i >= groupList.length) return;
      const group = groupList[i];
      const outcome = await discoverOne(group[0], llm, fetchHomepage, opts.providerLabel);
      const per = group.length > 0 ? outcome.cost / group.length : outcome.cost;
      for (const member of group) {
        results.set(member.id, { ...outcome, cost: per });
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  return results;
}
