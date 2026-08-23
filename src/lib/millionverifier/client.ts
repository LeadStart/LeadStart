// Million Verifier real-time API client.
//
// Single-address verification + a credits balance probe. Deliberately thin:
// ONE fetch attempt per call (the send cron's next tick is the retry — we never
// want an in-client retry loop eating the 60s cron budget), a hard client-side
// abort, and a typed error taxonomy the caller uses to decide whether to hold,
// skip, suppress, or alert.
//
// Docs: https://developer.millionverifier.com
//   GET /api/v3/?api=KEY&email=E&timeout=2..60
//     -> { email, quality, result, resultcode, subresult, free, role,
//          didyoumean, credits, executiontime, error, livemode }
//   GET /api/v3/credits?api=KEY  -> { credits }
//
// resultcode: 1 ok, 2 catch_all, 3 unknown, 4 error, 5 disposable, 6 invalid.
// catch_all + unknown are "risky" and NOT charged. When our client-side timeout
// param elapses server-side, the API returns result "unknown" (not an error) —
// so a slow mail server costs nothing and is retried, never sent-to blindly.
//
// IP-block guard: repeated calls with a bad key get the CALLER IP blocked, and
// Vercel egress IPs are shared. The caller (org-state + policy) therefore
// validates keys on save and stops calling for 1h after any definitive account
// error — this client just surfaces the right error kind for that decision.

export const MV_BASE_URL = "https://api.millionverifier.com/api/v3";

export type MillionVerifierErrorKind = "auth" | "credits" | "blocked" | "transient";

export interface MillionVerifierResponse {
  email: string;
  quality: string; // "good" | "bad" | "risky"
  result: string; // "ok" | "catch_all" | "unknown" | "error" | "disposable" | "invalid"
  resultcode: number;
  subresult: string;
  free: boolean;
  role: boolean;
  didyoumean: string;
  credits: number;
  executiontime: number;
  error: string;
  livemode: boolean;
}

// ---------- Typed errors ----------
// `definitive` errors (auth/credits/blocked) mean "stop calling for this org" —
// they trip the 1h suppression window + alert immediately. `transient` errors
// (network / 5xx / server timeout / internal) only trip the per-tick breaker
// and alert after a run of consecutive failing ticks.

export class MillionVerifierError extends Error {
  readonly kind: MillionVerifierErrorKind;
  readonly definitive: boolean;
  constructor(kind: MillionVerifierErrorKind, message: string) {
    super(message);
    this.name = "MillionVerifierError";
    this.kind = kind;
    this.definitive = kind !== "transient";
  }
}

// Missing / invalid / unknown API key (the API's NO_APIKEY + INVALID_APIKEY).
export class MillionVerifierConfigError extends MillionVerifierError {
  constructor(message: string) {
    super("auth", message);
    this.name = "MillionVerifierConfigError";
  }
}

// Account is out of verification credits.
export class MillionVerifierCreditsError extends MillionVerifierError {
  constructor(message: string) {
    super("credits", message);
    this.name = "MillionVerifierCreditsError";
  }
}

// This server's IP is blocked by Million Verifier (usually too many bad-key
// calls). Definitive: stop calling so we don't deepen the block.
export class MillionVerifierBlockedError extends MillionVerifierError {
  constructor(message: string) {
    super("blocked", message);
    this.name = "MillionVerifierBlockedError";
  }
}

// Network failure, timeout, 5xx, unparseable body, or the API's INTERNAL_ERROR.
// Retriable on a later tick.
export class MillionVerifierTransientError extends MillionVerifierError {
  constructor(message: string) {
    super("transient", message);
    this.name = "MillionVerifierTransientError";
  }
}

// Map an API-level `error` string (or an *_ERROR_* sandbox key's message) to a
// typed error. The exact strings are undocumented — pinned via
// scripts/probe-millionverifier-sandbox.ts and matched by keyword here. An
// unrecognized error is treated as TRANSIENT (hold, never send) — the safe
// default given the fail-closed policy.
export function classifyApiError(errorText: string): MillionVerifierError {
  const t = (errorText || "").toLowerCase();
  if (t.includes("credit")) return new MillionVerifierCreditsError(errorText);
  if (t.includes("block") || t.includes("ip address") || t.includes("ip is"))
    return new MillionVerifierBlockedError(errorText);
  if (t.includes("api key") || t.includes("apikey") || t.includes("api_key") || t.includes("no api"))
    return new MillionVerifierConfigError(errorText);
  return new MillionVerifierTransientError(errorText || "Million Verifier request failed");
}

async function getJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MillionVerifierTransientError(`Could not reach Million Verifier: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    // 5xx/4xx transport error. Read the body best-effort for context; treat as
    // transient (a bad key surfaces as a JSON `error` on a 200, handled below).
    let body = "";
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    throw new MillionVerifierTransientError(
      `Million Verifier HTTP ${response.status}: ${body.slice(0, 200)}`,
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new MillionVerifierTransientError("Million Verifier returned a non-JSON response");
  }
  if (!data || typeof data !== "object") {
    throw new MillionVerifierTransientError("Million Verifier returned an unexpected response");
  }
  return data as Record<string, unknown>;
}

export class MillionVerifierClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = (apiKey || "").trim();
  }

  // Verify one address. Resolves to the parsed API response even when
  // result === "error" (that's a per-ADDRESS verdict, not an account problem).
  // Throws a typed MillionVerifierError only for account/request-level failures
  // (bad key, no credits, IP blocked, transport/timeout).
  async verify(email: string, opts: { timeoutSec?: number } = {}): Promise<MillionVerifierResponse> {
    if (!this.apiKey) throw new MillionVerifierConfigError("Million Verifier API key is not set");
    const timeoutSec = Math.min(60, Math.max(2, opts.timeoutSec ?? 20));
    const qs = new URLSearchParams({
      api: this.apiKey,
      email,
      timeout: String(timeoutSec),
    });
    const url = `${MV_BASE_URL}/?${qs.toString()}`;
    // Client-side abort a couple seconds past the server-side timeout so a hung
    // socket can't blow the cron budget; the server should return first.
    const data = await getJson(url, (timeoutSec + 2) * 1000);

    const errorText = typeof data.error === "string" ? data.error : "";
    if (errorText) throw classifyApiError(errorText);
    if (typeof data.result !== "string") {
      throw new MillionVerifierTransientError("Million Verifier response missing `result`");
    }
    return data as unknown as MillionVerifierResponse;
  }

  // Remaining verification credits. Used by the settings "Test connection"
  // button and to refresh the cached balance. Same error taxonomy as verify().
  async credits(): Promise<number> {
    if (!this.apiKey) throw new MillionVerifierConfigError("Million Verifier API key is not set");
    const qs = new URLSearchParams({ api: this.apiKey });
    const url = `${MV_BASE_URL}/credits?${qs.toString()}`;
    const data = await getJson(url, 12_000);

    const errorText = typeof data.error === "string" ? data.error : "";
    if (errorText) throw classifyApiError(errorText);
    const credits = data.credits;
    if (typeof credits !== "number") {
      throw new MillionVerifierTransientError("Million Verifier credits response missing `credits`");
    }
    return credits;
  }
}
