// Managed unblocker client (tier 5) — the paid last resort for hard
// Cloudflare/DataDome cases the self-hosted tiers can't pass. Ported from the
// saasassins ScrapFly client, including the consecutive-429 circuit breaker so a
// quota-exhausted key fails instantly for the rest of the run instead of
// crawling on dead calls.
//
// Defaults to ScrapFly's ASP + render_js endpoint (~16 credits/req, ~$0.0024 on
// the $30/mo plan). The key is passed per run via input.unblockerKey; absent →
// this tier is simply never reached.

const ENDPOINT = "https://api.scrapfly.io/scrape";
const REQUEST_TIMEOUT_MS = 30_000;
const MIN_GAP_MS = 1200;
const MAX_RETRIES = 3; // per-call retries on a transient (concurrency) 429
const DISABLE_AFTER = 6; // consecutive all-429 calls => quota truly exhausted

let lastStart = 0;
let disabled = false;
let consecutive429 = 0;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UnblockerResult {
  html: string | null;
  status: number;
  error?: string;
}

export function isUnblockerExhausted(): boolean {
  return disabled;
}

export async function unblockerFetch(url: string, apiKey: string): Promise<UnblockerResult> {
  if (!apiKey) return { html: null, status: 0, error: "no unblocker key" };
  if (disabled) return { html: null, status: 429, error: "unblocker disabled this run (quota exhausted)" };

  let result: UnblockerResult = { html: null, status: 0, error: "unattempted" };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = 3000 * Math.pow(2, attempt - 1); // 3s, 6s, 12s — clears transient concurrency 429s
      console.log(`[unblocker] 429 — retry ${attempt}/${MAX_RETRIES} in ${backoff}ms for ${url}`);
      await delay(backoff);
    }
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await delay(wait);
    lastStart = Date.now();

    result = await unblockerOnce(url, apiKey);
    if (result.status !== 429) break;
  }

  if (result.status === 429) {
    consecutive429 += 1;
    if (consecutive429 >= DISABLE_AFTER && !disabled) {
      disabled = true;
      console.warn(`[unblocker] ${consecutive429} consecutive 429s — DISABLING for the rest of this run (quota likely exhausted)`);
    }
  } else {
    consecutive429 = 0;
  }
  return result;
}

async function unblockerOnce(url: string, apiKey: string): Promise<UnblockerResult> {
  const params = new URLSearchParams({
    key: apiKey,
    url,
    asp: "true", // Anti-Scraping Protection (Cloudflare/DataDome bypass)
    render_js: "true",
    country: "us",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${ENDPOINT}?${params}`, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { html: null, status: response.status, error: `unblocker HTTP ${response.status}: ${body.slice(0, 300)}` };
    }
    const data = (await response.json()) as { result?: { content?: unknown; status_code?: number } };
    const r = data?.result;
    if (!r) return { html: null, status: 0, error: "unblocker returned empty result" };
    if (r.status_code && r.status_code >= 400) {
      return { html: null, status: r.status_code, error: `target returned HTTP ${r.status_code}` };
    }
    const html = typeof r.content === "string" ? r.content : null;
    if (!html) return { html: null, status: r.status_code || 0, error: "unblocker result had no content" };
    return { html, status: r.status_code || 200 };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { html: null, status: 0, error: e.name === "AbortError" ? "unblocker timeout" : `unblocker error: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}
