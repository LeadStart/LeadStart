// Enrow email finder client (pay-per-hit, under test; not in the cron).
//
// Contract, from Enrow's own docs, read 2026-10-12:
//   https://docs.enrow.io/api-reference/email-finder/find-single
//   https://docs.enrow.io/api-reference/email-finder/get-single-result
//   https://docs.enrow.io/credits-billing
//
// Auth: header `x-api-key: <key>` (no Bearer). Base https://api.enrow.io.
//
// A search is ASYNCHRONOUS:
//   POST /email/find/single  body { fullname, company_domain | company_name }
//                            or { linkedin_url } (used only when no full
//                            name + company is sent; if both are sent the
//                            URL is ignored)
//     200 { message, id, credits_used }
//   GET  /email/find/single?id=<id>
//     202 { qualification: "ongoing" }           still running, poll again
//     200 { email, qualification: "valid" | "invalid", credits_used, info,
//           custom, linkedin_status?, linkedin_url? }
//   Reading a result never costs credits.
//
// Billing (credits-billing page): name + company find = 1 credit per email
// found, a miss is free (0.25 only for accounts with abnormally low success
// rates, after a warning). LinkedIn-URL find = 1 credit on a hit, 0.25 credit
// when no email is found, 0 when the lookup fails on Enrow's side.
// Catch-alls: Enrow runs "determinist verifications" and resolves them into
// valid / invalid itself; there is no catch-all status to pass on.
//
// Balance: GET /account/info -> { credits, webhooks } (credits-billing page).
// Errors: 401 bad/missing key ("This apikey is not valid."), 402
// { reason, success:false } out of credits, 400 { message } bad input.

import { bareDomain, EMPTY_RESULT, FinderError, sleep, type FinderResult } from "./types";

export const ENROW_BASE_URL = "https://api.enrow.io";

const POLL_INTERVAL_MS = 2_000;
const POLL_BUDGET_MS = 60_000;

// Pure: the 200 body of GET /email/find/single -> a normalised result.
// Exported for the fixture test (scripts/test-finders.ts).
export function parseEnrowResult(data: Record<string, unknown>, searchId: string | null): FinderResult {
  const qualification = typeof data.qualification === "string" ? data.qualification : null;
  const email = typeof data.email === "string" ? data.email.trim() : "";
  const credits = typeof data.credits_used === "number" ? data.credits_used : null;
  const linkedinStatus = typeof data.linkedin_status === "string" ? data.linkedin_status : null;
  const label = linkedinStatus ? `${qualification ?? "?"}/${linkedinStatus}` : qualification;
  if (qualification === "ongoing") {
    return { ...EMPTY_RESULT("enrow", "pending", label), search_id: searchId, credits_reported: credits };
  }
  if (qualification === "valid" && email) {
    return { provider: "enrow", status: "found", email, provider_status: label, credits_reported: credits, search_id: searchId };
  }
  return { ...EMPTY_RESULT("enrow", "not_found", label), search_id: searchId, credits_reported: credits };
}

function classify(status: number, body: string): FinderError {
  if (status === 401 || status === 403) return new FinderError("enrow", "auth", `Enrow rejected the API key (HTTP ${status}): ${body.slice(0, 160)}`);
  if (status === 402) return new FinderError("enrow", "credits", `Enrow out of credits (HTTP 402): ${body.slice(0, 160)}`);
  if (status === 429) return new FinderError("enrow", "transient", "Enrow rate-limited (HTTP 429)");
  if (status === 400) return new FinderError("enrow", "transient", `Enrow rejected the request (HTTP 400): ${body.slice(0, 160)}`);
  return new FinderError("enrow", "transient", `Enrow HTTP ${status}: ${body.slice(0, 160)}`);
}

export class EnrowClient {
  private readonly apiKey: string;
  constructor(apiKey: string) {
    this.apiKey = (apiKey || "").trim();
  }

  private async call(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: Record<string, unknown> }> {
    if (!this.apiKey) throw new FinderError("enrow", "auth", "Enrow API key is not set");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${ENROW_BASE_URL}${path}`, {
        method,
        headers: { "x-api-key": this.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new FinderError("enrow", "transient", `Could not reach Enrow: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok && response.status !== 202) {
      let text = "";
      try {
        text = await response.text();
      } catch {
        /* ignore */
      }
      throw classify(response.status, text);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new FinderError("enrow", "transient", "Enrow returned a non-JSON response");
    }
    if (!data || typeof data !== "object") throw new FinderError("enrow", "transient", "Enrow returned an unexpected response");
    return { status: response.status, data: data as Record<string, unknown> };
  }

  // Start a search. Exactly one input mode: name + domain, or a LinkedIn URL.
  private async start(body: Record<string, string>): Promise<string> {
    const { data } = await this.call("POST", "/email/find/single", body, 20_000);
    const id = typeof data.id === "string" ? data.id : "";
    if (!id) throw new FinderError("enrow", "transient", "Enrow did not return a search id");
    return id;
  }

  // Read one result; status "pending" while Enrow is still working.
  async read(searchId: string): Promise<FinderResult> {
    const { data } = await this.call("GET", `/email/find/single?id=${encodeURIComponent(searchId)}`, undefined, 20_000);
    return parseEnrowResult(data, searchId);
  }

  private async startAndPoll(body: Record<string, string>, opts: { pollBudgetMs?: number }): Promise<FinderResult> {
    const id = await this.start(body);
    const deadline = Date.now() + (opts.pollBudgetMs ?? POLL_BUDGET_MS);
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      const r = await this.read(id);
      if (r.status !== "pending" || Date.now() > deadline) return r;
    }
  }

  // Name + company domain. Never calls without both.
  async findByNameDomain(fullName: string, domain: string, opts: { pollBudgetMs?: number } = {}): Promise<FinderResult> {
    const n = (fullName || "").trim();
    const d = bareDomain(domain);
    if (!n || !d) return EMPTY_RESULT("enrow", "not_found", "skipped: missing name or domain");
    return this.startAndPoll({ fullname: n, company_domain: d }, opts);
  }

  // LinkedIn profile URL only (no name/company sent, or Enrow ignores the URL).
  // A miss costs 0.25 credit here, so the harness calls it only on name+domain misses.
  async findByLinkedInUrl(linkedinUrl: string, opts: { pollBudgetMs?: number } = {}): Promise<FinderResult> {
    const u = (linkedinUrl || "").trim();
    if (!/^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(u)) return EMPTY_RESULT("enrow", "not_found", "skipped: not a LinkedIn profile URL");
    return this.startAndPoll({ linkedin_url: u }, opts);
  }

  // Balance, for the settings "Test connection" button. Free.
  async remainingCredits(): Promise<number> {
    const { data } = await this.call("GET", "/account/info", undefined, 12_000);
    const c = data.credits;
    if (typeof c === "number") return c;
    if (typeof c === "string" && c.trim() && Number.isFinite(Number(c))) return Number(c);
    throw new FinderError("enrow", "transient", "Enrow account response missing `credits`");
  }
}
