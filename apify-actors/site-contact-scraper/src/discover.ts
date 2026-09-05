// Discovery-driven page selection: pure, dependency-free, unit-tested.
// Parse a homepage's internal links (href + anchor text), match them against
// contact-bearing keywords, and return same-origin candidate URLs in priority
// order (contact → team/leadership → about). The hardcoded FALLBACK_PATHS are
// used only when the homepage yields no usable links.

// Keyword → priority. Lower number = fetched sooner. Broad + multilingual so the
// scraper works for any ICP (owner decision, 2026-08-24).
export const DEFAULT_PAGE_KEYWORDS: { kw: string; priority: number }[] = [
  { kw: "contact", priority: 0 },
  { kw: "contact-us", priority: 0 },
  { kw: "contactus", priority: 0 },
  { kw: "kontakt", priority: 0 },
  { kw: "team", priority: 1 },
  { kw: "our-team", priority: 1 },
  { kw: "meet-the-team", priority: 1 },
  { kw: "meettheteam", priority: 1 },
  { kw: "leadership", priority: 1 },
  { kw: "management", priority: 1 },
  { kw: "staff", priority: 1 },
  { kw: "people", priority: 1 },
  { kw: "équipe", priority: 1 },
  { kw: "equipe", priority: 1 },
  { kw: "equipo", priority: 1 },
  { kw: "about", priority: 2 },
  { kw: "about-us", priority: 2 },
  { kw: "aboutus", priority: 2 },
  { kw: "company", priority: 2 },
  { kw: "über-uns", priority: 2 },
  { kw: "uber-uns", priority: 2 },
  { kw: "chi-siamo", priority: 2 },
];

// Fallback when a homepage has no parseable nav (JS-only nav, etc.).
export const FALLBACK_PATHS = ["/contact", "/contact-us", "/about", "/about-us", "/team", "/our-team"];

export interface DiscoverOptions {
  keywords?: { kw: string; priority: number }[];
  maxPages: number; // total pages incl. homepage; discovery returns up to maxPages-1
}

interface Candidate {
  url: string;
  priority: number;
}

// Pull (href, anchorText) pairs from <a> tags.
function anchors(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].trim();
    const textRaw = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (href) out.push({ href, text: textRaw });
  }
  return out;
}

function sameOriginUrl(href: string, baseUrl: string): string | null {
  try {
    const base = new URL(baseUrl);
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

// Priority for a link, from the best (lowest) keyword hit in its path or text.
function matchPriority(pathAndText: string, keywords: { kw: string; priority: number }[]): number | null {
  let best: number | null = null;
  for (const { kw, priority } of keywords) {
    if (pathAndText.includes(kw) && (best === null || priority < best)) best = priority;
  }
  return best;
}

export function discoverContactPages(homepageHtml: string, baseUrl: string, opts: DiscoverOptions): string[] {
  const keywords = opts.keywords ?? DEFAULT_PAGE_KEYWORDS;
  const limit = Math.max(0, opts.maxPages - 1); // homepage is fetched separately
  const homeUrl = (() => {
    try {
      return new URL(baseUrl).toString();
    } catch {
      return baseUrl;
    }
  })();

  const byUrl = new Map<string, number>(); // url → best priority
  for (const { href, text } of anchors(homepageHtml)) {
    const abs = sameOriginUrl(href, baseUrl);
    if (!abs || abs === homeUrl) continue;
    let pathText: string;
    try {
      pathText = (new URL(abs).pathname + " " + text).toLowerCase();
    } catch {
      pathText = (abs + " " + text).toLowerCase();
    }
    const priority = matchPriority(pathText, keywords);
    if (priority === null) continue;
    const prev = byUrl.get(abs);
    if (prev === undefined || priority < prev) byUrl.set(abs, priority);
  }

  const candidates: Candidate[] = Array.from(byUrl, ([url, priority]) => ({ url, priority }));
  // Discovered nav links win; if none, fall back to guessing common paths.
  if (candidates.length === 0) {
    for (const p of FALLBACK_PATHS) {
      const abs = sameOriginUrl(p, baseUrl);
      if (abs && abs !== homeUrl) {
        const priority = matchPriority(p, keywords) ?? 2;
        candidates.push({ url: abs, priority });
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority || a.url.localeCompare(b.url));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const c of candidates) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    ordered.push(c.url);
    if (ordered.length >= limit) break;
  }
  return ordered;
}
