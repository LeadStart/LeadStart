// Per-domain orchestration: fetch the homepage, discover contact-bearing pages,
// fetch those, and merge the extracted contacts into one record per domain.

import { fetchPage, type FetchVia } from "./fetchPage.js";
import { discoverContactPages } from "./discover.js";
import { extractContacts, type ExtractedContacts, type PersonEmail } from "./extract.js";

export interface ScrapeTarget {
  domain: string;
  firstName?: string | null;
  lastName?: string | null;
}

export type FetchOutcome =
  | "ok_http"
  | "ok_fingerprint"
  | "ok_fingerprint_proxy"
  | "ok_browser"
  | "ok_unblocker"
  | "blocked"
  | "empty"
  | "error";

export interface ScrapeResult {
  domain: string;
  emails: string[];
  companyEmails: string[];
  personEmails: PersonEmail[];
  phones: string[];
  socials: ExtractedContacts["socials"];
  usedBrowser: boolean;
  fetchOutcome: FetchOutcome;
  pagesFetched: number;
  error?: string;
}

export interface ScrapeOptions {
  maxPages: number;
  pageKeywords?: { kw: string; priority: number }[];
  proxyUrl?: string;
  unblockerKey?: string;
}

const VIA_TO_OUTCOME: Record<FetchVia, FetchOutcome> = {
  direct: "ok_http",
  fingerprint: "ok_fingerprint",
  fingerprint_proxy: "ok_fingerprint_proxy",
  playwright: "ok_browser",
  unblocker: "ok_unblocker",
};

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

const EMAIL_ANYWHERE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i;

function mergeInto(acc: ExtractedContacts, next: ExtractedContacts): void {
  const emails = new Set([...acc.emails, ...next.emails]);
  acc.emails = Array.from(emails).sort();
  acc.companyEmails = Array.from(new Set([...acc.companyEmails, ...next.companyEmails])).sort();
  const phones = new Set([...acc.phones.map((p) => p.replace(/\D/g, ""))]);
  for (const p of next.phones) {
    const key = p.replace(/\D/g, "");
    if (!phones.has(key)) {
      phones.add(key);
      acc.phones.push(p);
    }
  }
  // personEmails: dedupe by address, OR the nameMatched flag.
  const byEmail = new Map<string, PersonEmail>();
  for (const pe of [...acc.personEmails, ...next.personEmails]) {
    const prev = byEmail.get(pe.email);
    byEmail.set(pe.email, { email: pe.email, nameMatched: (prev?.nameMatched || pe.nameMatched) ?? false });
  }
  acc.personEmails = Array.from(byEmail.values());
  acc.socials = { ...next.socials, ...acc.socials }; // keep first-seen
}

export async function scrapeDomain(target: ScrapeTarget, opts: ScrapeOptions): Promise<ScrapeResult> {
  const domain = normalizeDomain(target.domain);
  const baseUrl = `https://${domain}`;
  const merged: ExtractedContacts = { emails: [], companyEmails: [], personEmails: [], phones: [], socials: {} };
  const extractTarget = { firstName: target.firstName, lastName: target.lastName };

  const empty = (fetchOutcome: FetchOutcome, error?: string): ScrapeResult => ({
    domain,
    emails: [],
    companyEmails: [],
    personEmails: [],
    phones: [],
    socials: {},
    usedBrowser: false,
    fetchOutcome,
    pagesFetched: 0,
    error,
  });

  if (!domain) return empty("error", "no domain");

  // 1. Homepage: accept anything (we need HTML to discover from).
  const home = await fetchPage(baseUrl, { proxyUrl: opts.proxyUrl, unblockerKey: opts.unblockerKey });
  if (!home.html) {
    const outcome: FetchOutcome = home.status === 403 || home.status === 429 ? "blocked" : home.status === 0 ? "error" : "empty";
    return empty(outcome, home.error);
  }
  let usedBrowser = home.via === "playwright";
  let pagesFetched = 1;
  const homeOutcome: FetchOutcome = home.via ? VIA_TO_OUTCOME[home.via] : "ok_http";
  mergeInto(merged, extractContacts(home.html, extractTarget, domain));

  // 2. Discover + fetch contact-bearing pages. Accept a page that yields an
  //    email OR the target's name: a clean-but-empty page escalates to a browser
  //    render (which may reveal JS-injected mailtos) instead of being a miss.
  const accept = (html: string) => EMAIL_ANYWHERE.test(html);
  const candidates = discoverContactPages(home.html, baseUrl, {
    keywords: opts.pageKeywords,
    maxPages: opts.maxPages,
  });
  for (const url of candidates) {
    const page = await fetchPage(url, { accept, proxyUrl: opts.proxyUrl, unblockerKey: opts.unblockerKey });
    if (page.via === "playwright") usedBrowser = true;
    if (page.html) {
      pagesFetched++;
      mergeInto(merged, extractContacts(page.html, extractTarget, domain));
    }
  }

  return {
    domain,
    emails: merged.emails,
    companyEmails: merged.companyEmails,
    personEmails: merged.personEmails,
    phones: merged.phones,
    socials: merged.socials,
    usedBrowser,
    fetchOutcome: homeOutcome,
    pagesFetched,
  };
}
