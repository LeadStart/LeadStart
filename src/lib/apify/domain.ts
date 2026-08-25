// Pure URL/domain helpers for the enrichment pipeline. No network, no deps —
// exercised directly by scripts/test-apify-enrichment.ts.

// Hosts that are never a company's own website — social, aggregators, generic
// site builders, link-in-bio. Matched as an exact host or a subdomain suffix.
export const REJECTED_HOSTS: readonly string[] = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "google.com",
  "sites.google.com",
  "wixsite.com",
  "wix.com",
  "squarespace.com",
  "godaddysites.com",
  "weebly.com",
  "wordpress.com",
  "blogspot.com",
  "bit.ly",
  "linktr.ee",
  "crunchbase.com",
  "glassdoor.com",
  "indeed.com",
  "yelp.com",
  "medium.com",
  "github.io",
  "notion.site",
  "carrd.co",
];

// Two-label public suffixes where the registrable domain needs three labels.
const MULTI_PART_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "co.in",
  "co.za",
  "com.br",
  "com.mx",
  "com.sg",
  "com.hk",
  "co.kr",
  "com.tr",
]);

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// Reduce a hostname to its registrable domain (eTLD+1), using the small
// MULTI_PART_TLDS set rather than a full public-suffix list (deliberate — the
// long tail isn't worth the dependency for cold-email domains).
export function registrableDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

// Normalize a scraped website value to a bare registrable domain, or null if
// it isn't a usable company domain.
export function normalizeDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  let raw = website.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = "http://" + raw;

  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.$/, ""); // trailing dot
  host = host.replace(/^www\./, "");

  if (!host) return null;
  if (IPV4_RE.test(host)) return null;
  if (host.includes(":")) return null; // stray IPv6/port
  if (host === "localhost") return null;
  if (!host.includes(".")) return null;

  const tld = host.split(".").pop() ?? "";
  if (tld.length < 2 || /\d/.test(tld)) return null;

  if (
    REJECTED_HOSTS.some((b) => host === b || host.endsWith("." + b))
  ) {
    return null;
  }

  return registrableDomain(host);
}

// LinkedIn profile URN id, e.g. https://www.linkedin.com/in/ACwAAAiq... → ACwAAAiq...
export function extractProfileId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

// Numeric LinkedIn company id, e.g. /company/19178324 → "19178324".
export function extractCompanyId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/company\/(\d+)(?:[/?#]|$)/i);
  return m ? m[1] : null;
}

// Keep a company LinkedIn URL only if it's a real /company/ page. HarvestAPI
// hands back a SEARCH link (linkedin.com/search/results/all/?keywords=Name) when
// a person's employer has no LinkedIn company page — that's not a company URL, so
// storing it just pollutes company_linkedin_url and makes the domains phase log a
// misleading "no parseable company LinkedIn URL". Drop it to null instead.
export function sanitizeCompanyUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  return /linkedin\.com\/company\//i.test(u) ? u : null;
}

// Company slug (non-numeric), e.g. /company/pritchard-industries → "pritchard-industries".
export function extractCompanySlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).toLowerCase();
  if (/^\d+$/.test(slug)) return null; // numeric → that's an id, not a slug
  return slug;
}

const LEGAL_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "plc",
  "sa",
  "srl",
  "lp",
  "llp",
  "pllc",
  "group",
]);

// Fold a company name for fuzzy equality: lowercase, drop punctuation + legal
// suffixes, collapse whitespace.
export function normalizeCompanyName(name: string | null | undefined): string {
  if (!name) return "";
  const cleaned = name
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=_`~()®™"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((w) => w && !LEGAL_SUFFIXES.has(w));
  return words.join(" ");
}
