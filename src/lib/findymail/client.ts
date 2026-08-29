// Findymail real-time API client.
//
// A finder, NOT a verifier: given a name + company domain it returns a single
// VERIFIED, deliverable email, and Findymail's own catch-all recovery means it
// can return deliverable addresses on catch-all domains that our pattern_mv +
// Million Verifier stack is structurally blind to. That is the ONE thing it does
// that our stack can't, and it's why it slots in as the catch-all recovery step.
//
// Billing (their published model): 1 credit per SUCCESSFUL find (a verified email
// returned). No result = no charge. Risky catch-alls are withheld (not returned,
// not charged). Bounces on a returned email are credit-refunded. So a find that
// returns nothing costs nothing — the caller only pays on a hit.
//
// Verified contract (their public API docs, 2026-08-29):
//   POST https://app.findymail.com/api/search/name
//     headers: Authorization: Bearer <key>, Content-Type: application/json
//     body:    { "name": "<full name>", "domain": "<company domain>" }
//     200:     { "contact": { "name": "...", "email": "...", "domain": "..." } }
//              (a miss returns no email — contact null / absent / email empty)
//
// UNVERIFIED (confirm against the live account before trusting for anything but
// the finder): the credits/account endpoint path and the exact miss-response
// shape. Both are flagged below. Only the settings "Test connection" credit
// readout depends on the credits path; the finder itself does not.
//
// Deliberately thin, mirroring the Million Verifier client: ONE fetch attempt per
// call (the cron's next tick is the retry — no in-client retry loop eating the
// tick budget), a hard client-side abort, and a typed error taxonomy the caller
// uses to decide whether to skip, hold, or alert.

export const FINDYMAIL_BASE_URL = "https://app.findymail.com";

export type FindymailErrorKind = "auth" | "credits" | "blocked" | "transient";

// Typed errors. `definitive` (auth/credits/blocked) means "stop calling for this
// org" — unlike Million Verifier this is NOT a send gate, so a definitive error
// just skips the recovery step for the run and can alert; it never holds sends.
export class FindymailError extends Error {
  readonly kind: FindymailErrorKind;
  readonly definitive: boolean;
  constructor(kind: FindymailErrorKind, message: string) {
    super(message);
    this.name = "FindymailError";
    this.kind = kind;
    this.definitive = kind !== "transient";
  }
}

// One find outcome. `found` is true only when a deliverable email came back;
// `credit_charged` mirrors that (Findymail charges only on a hit) so the caller
// can tally real spend rather than assume one credit per call.
export interface FindymailResult {
  found: boolean;
  email: string | null;
  name: string | null;
  credit_charged: boolean;
}

// Pure: pull the email (+ name) out of a parsed /search/name response. Findymail
// nests the hit under `contact`; a miss omits it or returns a null/empty email.
// Exported for unit tests (scripts/test-findymail.ts) so the parse never drifts.
export function parseFindResponse(data: Record<string, unknown>): FindymailResult {
  const contact = data.contact;
  if (!contact || typeof contact !== "object") {
    return { found: false, email: null, name: null, credit_charged: false };
  }
  const c = contact as Record<string, unknown>;
  const email = typeof c.email === "string" ? c.email.trim() : "";
  const name = typeof c.name === "string" ? c.name.trim() : "";
  if (!email) return { found: false, email: null, name: name || null, credit_charged: false };
  return { found: true, email, name: name || null, credit_charged: true };
}

// Map an HTTP status (on a non-2xx) to a typed error kind. 401/403 = auth,
// 402 = out of credits, 429 = rate-limited (transient), everything else 5xx/4xx
// = transient (retry a later tick). Findymail's exact bodies aren't documented;
// status is the reliable signal, so we key on it.
function classifyStatus(status: number, body: string): FindymailError {
  if (status === 401 || status === 403) return new FindymailError("auth", `Findymail auth failed (HTTP ${status}): ${body.slice(0, 160)}`);
  if (status === 402) return new FindymailError("credits", `Findymail out of credits (HTTP 402): ${body.slice(0, 160)}`);
  if (status === 429) return new FindymailError("transient", `Findymail rate-limited (HTTP 429)`);
  return new FindymailError("transient", `Findymail HTTP ${status}: ${body.slice(0, 160)}`);
}

export class FindymailClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = (apiKey || "").trim();
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.apiKey) throw new FindymailError("auth", "Findymail API key is not set");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${FINDYMAIL_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new FindymailError("transient", `Could not reach Findymail: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      let text = "";
      try {
        text = await response.text();
      } catch {
        /* ignore */
      }
      throw classifyStatus(response.status, text);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new FindymailError("transient", "Findymail returned a non-JSON response");
    }
    if (!data || typeof data !== "object") {
      throw new FindymailError("transient", "Findymail returned an unexpected response");
    }
    return data as Record<string, unknown>;
  }

  // Find a deliverable email from a full name + company domain. Returns
  // { found:false } on a miss (no charge). Throws a typed FindymailError only for
  // account/request-level failures (bad key, no credits, transport/timeout).
  async findByNameDomain(
    name: string,
    domain: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<FindymailResult> {
    const n = (name || "").trim();
    const d = (domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (!n || !d) return { found: false, email: null, name: null, credit_charged: false };
    const data = await this.post("/api/search/name", { name: n, domain: d }, opts.timeoutMs ?? 20_000);
    return parseFindResponse(data);
  }

  // Remaining finder credits — used ONLY by the settings "Test connection"
  // button to validate the key and show a balance. VERIFY the endpoint path
  // against the live account before relying on the number; a wrong path here
  // surfaces as a Test-connection error and never touches the finder path.
  async remainingCredits(): Promise<number> {
    const data = await this.post("/api/credits", {}, 12_000);
    // Accept a few plausible shapes: { credits }, { credits: { verifier, finder } }.
    const c = data.credits;
    if (typeof c === "number") return c;
    if (c && typeof c === "object") {
      const finder = (c as Record<string, unknown>).finder;
      if (typeof finder === "number") return finder;
    }
    throw new FindymailError("transient", "Findymail credits response missing `credits`");
  }
}
