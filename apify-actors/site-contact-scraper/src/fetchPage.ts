// The anti-bot fetch waterfall — the actor's core "get this page's HTML past its
// bot defenses" primitive. Generalized from the saasassins engine, with two tiers
// added (fingerprint-over-proxy, and the unblocker key-gated).
//
// Tier order (fast/free → slow/paid). Each tier's result is gated by an optional
// `accept(html, status)` predicate; a rejected result falls through:
//   1. direct              — plain HTTPS + Chrome UA, datacenter IP (~100ms, free)
//   2. fingerprint         — curl_cffi TLS/JA3 + HTTP-2 Chrome impersonation, no
//                            browser (~250ms, free) — beats TLS/WAF gating
//   3. fingerprint+proxy   — same, over a residential IP (small proxy cost) —
//                            beats IP-reputation blocks a datacenter IP fails
//   4. playwright+stealth  — real rendered browser, only for JS-BUILT pages
//   5. unblocker           — managed ASP+render_js, key-gated, hard CF/DataDome
//
// Politeness (enforced): a per-domain minimum gap between request starts, and a
// per-domain cooldown once a domain refuses (403/429) at EVERY tier. We escalate
// tiers on a block; we never hammer. NEVER add login, CAPTCHA-solving, or evasion
// beyond fingerprint-correct polite fetching of public pages.

import { type Browser, type BrowserContext } from "playwright";
import { chromium as stealthChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { lookup } from "node:dns/promises";
import { fingerprintFetch, isFingerprintConfigured } from "./fingerprintFetch.js";
import { unblockerFetch, isUnblockerExhausted } from "./unblocker.js";

stealthChromium.use(StealthPlugin());

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- SSRF guard
const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc/i,
  /^fd/i,
  /^fe80/i,
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_RANGES.some((p) => p.test(ip));
}

async function validateUrl(url: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { valid: false, error: `blocked protocol: ${parsed.protocol}` };
    }
    if (parsed.hostname === "localhost" || parsed.hostname === "0.0.0.0") {
      return { valid: false, error: "blocked localhost" };
    }
    try {
      const result = await lookup(parsed.hostname);
      if (isPrivateIp(result.address)) return { valid: false, error: `blocked private IP: ${result.address}` };
    } catch {
      return { valid: false, error: `DNS lookup failed for ${parsed.hostname}` };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "invalid URL format" };
  }
}

// ---------------------------------------------------------------- politeness
const DOMAIN_MIN_GAP_MS = 1500;
const BLOCKED_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const lastDomainStart = new Map<string, number>();
const domainBlockedUntil = new Map<string, number>();

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function paceDomain(domain: string): Promise<void> {
  const wait = (lastDomainStart.get(domain) ?? 0) + DOMAIN_MIN_GAP_MS - Date.now();
  if (wait > 0) await delay(wait);
  lastDomainStart.set(domain, Date.now());
}

// ---------------------------------------------------------------- shared browser
let browserInstance: Browser | null = null;
let browserProxy: string | undefined;

async function getBrowser(proxyUrl?: string): Promise<Browser> {
  // Relaunch if the proxy config changed (typically constant across a run).
  if (browserInstance && browserInstance.isConnected() && browserProxy === proxyUrl) {
    return browserInstance;
  }
  if (browserInstance) await browserInstance.close().catch(() => {});
  browserProxy = proxyUrl;
  browserInstance = await stealthChromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    proxy: proxyUrl ? { server: proxyUrl } : undefined,
  });
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

// ---------------------------------------------------------------- block heuristics
// A 200 whose body is a challenge page is NOT a success. Deliberately specific —
// a bare "cloudflare"/"captcha" mention appears on legit pages. We do NOT reject
// on page smallness: legit minimal company/team pages are often tiny.
const BLOCK_TEXT =
  /pardon our interruption|are you a (robot|human)|please verify you are (a )?human|verifying you are human|checking your browser before|just a moment\.\.\.|attention required!|enable javascript and cookies to continue|access to this page has been denied/i;

function looksBlocked(html: string): boolean {
  if (html.trim().length < 120) return true; // effectively empty
  return BLOCK_TEXT.test(html.slice(0, 4000));
}

// ---------------------------------------------------------------- tiers
interface TierResult {
  html: string | null;
  status: number;
  error?: string;
}

async function tierDirect(url: string): Promise<TierResult> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    const status = response.status;
    if (!response.ok) return { html: null, status, error: `HTTP ${status}` };
    const html = await response.text();
    if (looksBlocked(html)) return { html: null, status, error: "block/challenge page" };
    return { html, status };
  } catch (err) {
    return { html: null, status: 0, error: `direct fetch error: ${(err as Error).message}` };
  }
}

async function tierFingerprint(url: string, proxyUrl?: string): Promise<TierResult> {
  if (!(await isFingerprintConfigured())) return { html: null, status: 0, error: "fingerprint not configured" };
  const r = await fingerprintFetch(url, proxyUrl);
  if (!r.html) return { html: null, status: r.status, error: r.error || "fingerprint returned no HTML" };
  if (looksBlocked(r.html)) return { html: null, status: r.status, error: "block/challenge page" };
  return { html: r.html, status: r.status };
}

async function tierPlaywright(url: string, proxyUrl?: string): Promise<TierResult> {
  let context: BrowserContext | null = null;
  try {
    const browser = await getBrowser(proxyUrl);
    context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    const response = await page.goto(url, { timeout: 15000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const status = response?.status() ?? 200;
    const rawBody = (await page.textContent("body")) || "";
    if (rawBody.length < 200 || BLOCK_TEXT.test(rawBody)) {
      return { html: null, status, error: "anti-bot block detected" };
    }
    const html = await page.content();
    if (!html || html.length < 600) return { html: null, status, error: "empty rendered page" };
    return { html, status };
  } catch (err) {
    return { html: null, status: 0, error: `playwright error: ${(err as Error).message}` };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function tierUnblocker(url: string, unblockerKey?: string): Promise<TierResult> {
  if (!unblockerKey || isUnblockerExhausted()) return { html: null, status: 0, error: "unblocker unavailable" };
  const r = await unblockerFetch(url, unblockerKey);
  if (!r.html) return { html: null, status: r.status, error: r.error || "unblocker returned no HTML" };
  return { html: r.html, status: r.status };
}

// ---------------------------------------------------------------- public API
export type FetchVia = "direct" | "fingerprint" | "fingerprint_proxy" | "playwright" | "unblocker";

export interface FetchPageResult {
  html: string | null;
  status: number;
  via: FetchVia | null;
  error?: string;
}

export interface FetchPageOptions {
  // Accept a tier's result only if this returns true (e.g. "contains an email or
  // the target's name"). A rejected result falls through; the last usable HTML is
  // returned if every tier fails accept.
  accept?: (html: string, status: number) => boolean;
  // Skip the browser + unblocker tiers (for bulk static sweeps).
  staticOnly?: boolean;
  // Residential proxy URL (Apify), enabling tiers 3 (fingerprint+proxy) and the
  // proxy on tier 4 (playwright). Absent → those run direct/skip.
  proxyUrl?: string;
  // Managed unblocker key, enabling tier 5. Absent → the ladder stops at tier 4.
  unblockerKey?: string;
}

export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchPageResult> {
  const check = await validateUrl(url);
  if (!check.valid) return { html: null, status: 0, via: null, error: check.error };

  const domain = domainOf(url);
  const blockedUntil = domainBlockedUntil.get(domain) ?? 0;
  if (blockedUntil > Date.now()) {
    return { html: null, status: 429, via: null, error: `domain ${domain} on block-cooldown` };
  }
  await paceDomain(domain);

  const accept = opts.accept ?? (() => true);
  const errors: string[] = [];
  const statuses: number[] = [];

  const tiers: { via: FetchVia; run: () => Promise<TierResult> }[] = [
    { via: "direct", run: () => tierDirect(url) },
    { via: "fingerprint", run: () => tierFingerprint(url) },
    ...(opts.proxyUrl ? [{ via: "fingerprint_proxy" as const, run: () => tierFingerprint(url, opts.proxyUrl) }] : []),
    ...(opts.staticOnly
      ? []
      : [
          { via: "playwright" as const, run: () => tierPlaywright(url, opts.proxyUrl) },
          { via: "unblocker" as const, run: () => tierUnblocker(url, opts.unblockerKey) },
        ]),
  ];

  let last: FetchPageResult | null = null;
  for (const tier of tiers) {
    const r = await tier.run();
    statuses.push(r.status);
    if (r.html && accept(r.html, r.status)) {
      if (tier.via !== "direct") console.log(`[fetch] ${tier.via} ok for ${url}`);
      return { html: r.html, status: r.status, via: tier.via };
    }
    if (r.html) last = { html: r.html, status: r.status, via: tier.via, error: "html rejected by accept()" };
    errors.push(`${tier.via}: ${r.error || "rejected by accept()"}`);
  }

  if (last) return last;

  if (statuses.some((s) => s === 403 || s === 429)) {
    domainBlockedUntil.set(domain, Date.now() + BLOCKED_COOLDOWN_MS);
    console.warn(`[fetch] ${domain} refused at every tier (403/429) — cooling down 6h`);
  }
  return { html: null, status: statuses.find((s) => s > 0) ?? 0, via: null, error: errors.join("; ") };
}
