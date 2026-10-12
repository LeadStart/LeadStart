// HTML fetching + plain-text extraction for Layer 1 (website scrape), first
// ported from server/enricher.ts:183-258. fetchPage also reads homepages for
// the domain-discovery check in run-apify-enrichment. Layer 2 (Perplexity web
// search) needs none of this.

// A full desktop-Chrome request. The old bare UA ("…AppleWebKit/537.36", with
// no Chrome/ or Safari/ token) reads as a bot: re-reading 147 cleaning-company
// sites on 2026-10-11, 7 answered it with a 403 and 6 of those served the page
// to a full Chrome UA. Bump the version now and then (stable was 154-155 in
// October 2026). Node's fetch forces its own `sec-fetch-mode: cors`, so no
// other sec-fetch-* headers are sent: a navigation set would contradict it.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Whole pages, for Layer 1. Site-builder pages (GoDaddy, Wix, Squarespace…)
// can carry hundreds of KB of inline CSS before <body> starts
// (bluehousecleaning.com: a 975 KB page whose <body> opens at 495 KB), so a
// 200 KB cut lost their entire content, links included.
export const PAGE_HTML_MAX_CHARS = 2_000_000;

export interface FetchPageOptions {
  timeoutMs?: number;
  // HTML kept, in chars. The 200 KB default is what the domain-discovery
  // homepage check has always read; Layer 1 passes PAGE_HTML_MAX_CHARS.
  maxChars?: number;
}

export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<string> {
  const { timeoutMs = 10_000, maxChars = 200_000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: BROWSER_HEADERS,
      redirect: "follow",
    });
    if (!response.ok) return "";
    const html = await response.text();
    return html.substring(0, maxChars);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- tokenizer

// A run of text, or one tag. Tags are positions into the HTML (start = "<",
// end = ">"); `name` is the lower-cased element name ("" for <!doctype> etc.).
type HtmlToken =
  | { kind: "text"; text: string }
  | { kind: "tag"; name: string; closing: boolean; start: number; end: number };

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13);

// Index of the ">" that ends the tag opened at `lt`, or -1 if it never ends.
// Quote-aware like a browser: a quoted attribute value may run any length
// (Elementor/WordPress data-settings JSON and srcset lists often top 500
// chars) and may hold a ">". Every char is visited once.
function tagEnd(html: string, lt: number): number {
  let afterEquals = false;
  for (let i = lt + 1; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (c === 62 /* > */) return i;
    if (afterEquals && (c === 34 /* " */ || c === 39 /* ' */)) {
      i = html.indexOf(c === 34 ? '"' : "'", i + 1);
      if (i === -1) return -1;
      afterEquals = false;
    } else if (c === 61 /* = */) {
      afterEquals = true;
    } else if (!isSpace(c)) {
      afterEquals = false;
    }
  }
  return -1;
}

function tagName(html: string, from: number, end: number): string {
  let i = from;
  while (i < end) {
    const c = html.charCodeAt(i);
    if (isSpace(c) || c === 47 /* / */ || c === 62 /* > */) break;
    i++;
  }
  return html.slice(from, i).toLowerCase();
}

// Index of the "</script" (or "</style") that ends a raw-text block, or -1.
function closeTagIndex(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}[\\s/>]`, "gi");
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : -1;
}

// Split HTML into text runs and tags in one linear pass. Comments and the
// insides of <script>/<style> are skipped; a "<" that opens no tag ("a < b")
// stays text; an unterminated tag or comment ends the document, as in a browser.
function* tokenize(html: string): Generator<HtmlToken> {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      yield { kind: "text", text: html.slice(i) };
      return;
    }
    if (lt > i) yield { kind: "text", text: html.slice(i, lt) };
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      if (close === -1) return;
      i = close + 3;
      continue;
    }
    const closing = html.charCodeAt(lt + 1) === 47; // "</"
    const first = html.charCodeAt(lt + (closing ? 2 : 1));
    // <!doctype>, <?xml?> and <![CDATA[ are skipped like tags.
    const opensTag = isLetter(first) || (!closing && (first === 33 /* ! */ || first === 63 /* ? */));
    if (!opensTag) {
      yield { kind: "text", text: "<" };
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt);
    if (end === -1) return;
    const name = isLetter(first) ? tagName(html, lt + (closing ? 2 : 1), end) : "";
    yield { kind: "tag", name, closing, start: lt, end };
    i = end + 1;
    if (!closing && (name === "script" || name === "style")) {
      const close = closeTagIndex(html, name, i);
      if (close === -1) return;
      i = close;
    }
  }
}

// ---------------------------------------------------------------- HTML → text

// Each page's text is capped here only to bound memory; how much of it the
// model sees is decided per page by Layer 1's prompt budget (layer1.ts).
const PAGE_TEXT_MAX_CHARS = 50_000;

const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "],
  ["lsquo", "‘"], ["rsquo", "’"], ["ldquo", "“"], ["rdquo", "”"],
  ["ndash", "–"], ["mdash", "—"], ["hellip", "…"], ["middot", "·"], ["bull", "•"],
  ["copy", "©"], ["reg", "®"], ["trade", "™"],
  ["szlig", "ß"], ["aelig", "æ"], ["AElig", "Æ"], ["oslash", "ø"], ["Oslash", "Ø"],
]);
// Accented letters (&eacute;, &Ntilde;, …) compose from the letter plus a
// combining mark, so "Jos&eacute;" reads "José" rather than "Jos ".
const ACCENT_MARKS = new Map<string, string>([
  ["acute", "\u0301"], ["grave", "\u0300"], ["circ", "\u0302"], ["tilde", "\u0303"],
  ["uml", "\u0308"], ["ring", "\u030A"], ["cedil", "\u0327"],
]);

// Decode character references in one pass, so "&amp;lt;" stays "&lt;". The old
// strip turned every one but four into a space, so "O&#8217;Brien" (WordPress
// writes &#8217; for each apostrophe) reached the model as "O Brien". An
// unknown named reference still becomes a space.
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,7}));/g,
    (_m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name) {
        const named = NAMED_ENTITIES.get(name);
        if (named !== undefined) return named;
        const mark = ACCENT_MARKS.get(name.slice(1));
        return mark && isLetter(name.charCodeAt(0)) ? (name[0] + mark).normalize("NFC") : " ";
      }
      const cp = dec ? Number(dec) : parseInt(hex as string, 16);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : " ";
    },
  );
}

// Plain text of a page, for the model: comments and <script>/<style> blocks
// go entirely, every other tag becomes a space however long its attributes run
// (the old /<[^>]{0,500}>/ strip leaked every tag over 500 chars, so Elementor
// data-settings and srcset lists landed in the prompt), and entities decode.
// The whole page is read: the old 100K-char cut ran BEFORE <style> blocks were
// dropped, so a page with a big inline stylesheet came out as just its title.
export function htmlToText(html: string): string {
  const parts: string[] = [];
  for (const token of tokenize(html)) parts.push(token.kind === "text" ? token.text : " ");
  return decodeEntities(parts.join(""))
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, PAGE_TEXT_MAX_CHARS);
}

// ---------------------------------------------------------------- links

// Linked pages worth reading for a decision maker, best first. A link counts
// when its URL path or its anchor text matches a rule, and takes the rank of
// the best rule it matches: pages about the people (where owners get named)
// beat pages that sometimes list them, then contact pages, then careers pages.
const PAGE_RANKS: RegExp[] = [
  /about|(?:\b|our|the)teams?\b|\bmeet\b|\bowners?\b|\bfounders?\b|\bleadership\b|\bwho[\s_-]?we[\s_-]?are\b|\bwho[\s_-]?are[\s_-]?we\b|\b(?:our[\s_-]?)?story\b|\bhistory\b/i,
  /\bstaff\b|\bpeople\b|\bmanagement\b|\bboard\b|\bfaculty\b|\bwhy[\s_-]?(?:choose[\s_-]?)?us\b/i,
  /contact/i,
];
// "Join our team" and the like name nobody; read them only if nothing else fills the slots.
const CAREERS_PAGE = /\b(?:careers?|jobs?|join|hiring|employment)\b/i;
// Menu labels are short; a longer anchor is a content card ("Learn more about
// our carpet cleaning…"), so its text doesn't count as a match.
const ANCHOR_TEXT_MAX_CHARS = 30;
const MAX_CONTACT_PAGES = 4;

function pageRank(text: string): number {
  const i = PAGE_RANKS.findIndex((re) => re.test(text));
  if (i === -1) return -1;
  return CAREERS_PAGE.test(text) ? PAGE_RANKS.length : i;
}

// The same page however it's linked: no #fragment, no "www.", no trailing
// slash, no tracking params (Maps website URLs often carry utm_*).
function samePageKey(url: URL): string {
  const params = new URLSearchParams(url.search);
  for (const k of [...params.keys()]) {
    if (/^(?:utm_|gclid$|fbclid$|msclkid$)/i.test(k)) params.delete(k);
  }
  const search = params.toString();
  return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${search ? `?${search}` : ""}`;
}

// Up to 4 linked pages most likely to name the decision maker, ranked as above
// (ties keep page order, URL matches ahead of anchor-text-only ones). Links back
// to the page itself ("/#about") are skipped, and a page linked twice (with and
// without a #fragment) is read once: both used to take one of the 4 slots.
export function findContactPages(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const baseKey = samePageKey(base);
  const found = new Map<string, { url: string; sortKey: number; order: number }>();
  const consider = (href: string, anchorText: string) => {
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      return; // Invalid URL, skip.
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    url.hash = "";
    const key = samePageKey(url);
    if (key === baseKey) return;
    const urlRank = pageRank(decodeURIComponentSafe(url.pathname + url.search));
    const textRank = anchorText.length <= ANCHOR_TEXT_MAX_CHARS ? pageRank(anchorText) : -1;
    if (urlRank === -1 && textRank === -1) return;
    const sortKey =
      urlRank !== -1 && (textRank === -1 || urlRank <= textRank) ? urlRank * 2 : textRank * 2 + 1;
    const prev = found.get(key);
    if (!prev) found.set(key, { url: url.href, sortKey, order: found.size });
    else if (sortKey < prev.sortKey) prev.sortKey = sortKey;
  };

  // Walk <a href>…</a>, collecting each link's text (nested markup included).
  let open: { href: string; text: string } | null = null;
  const close = () => {
    if (open) consider(open.href, decodeEntities(open.text).replace(/\s+/g, " ").trim());
    open = null;
  };
  for (const token of tokenize(html)) {
    if (token.kind === "text") {
      // Past the label limit the text no longer matters, so stop growing it.
      if (open && open.text.length <= ANCHOR_TEXT_MAX_CHARS * 4) open.text += ` ${token.text}`;
      continue;
    }
    if (token.name !== "a") continue;
    close();
    if (token.closing) continue;
    const href = hrefOf(html.slice(token.start, token.end + 1));
    if (href) open = { href, text: "" };
  }
  close();

  return [...found.values()]
    .sort((a, b) => a.sortKey - b.sortKey || a.order - b.order)
    .slice(0, MAX_CONTACT_PAGES)
    .map((p) => p.url);
}

function hrefOf(tag: string): string | null {
  const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
  const href = m ? (m[1] ?? m[2] ?? m[3]) : null;
  return href ? decodeEntities(href).trim() || null : null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
