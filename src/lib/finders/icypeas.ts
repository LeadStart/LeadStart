// Icypeas email finder client (pay-per-hit, under test; not in the cron).
//
// Contract, from Icypeas's own docs, read 2026-10-12:
//   https://api-doc.icypeas.com/getting-started/
//   https://api-doc.icypeas.com/find-emails/email-discovery/
//   https://api-doc.icypeas.com/fetch-results/search-item/
//   https://api-doc.icypeas.com/how-works/search_statuses/
//   https://api-doc.icypeas.com/how-works/credit-cost/
//   https://api-doc.icypeas.com/how-works/rate_limits/
//
// Auth: header `Authorization: <key>` ("containing your API key, and ONLY your
// API key": no Bearer prefix) + Content-Type application/json.
// Base https://app.icypeas.com/api.
//
// A search is ASYNCHRONOUS:
//   POST /email-search  body { firstname, lastname, domainOrCompany,
//                              custom?: { externalId?, webhookUrl? } }
//     200 { success: true, item: { status: "NONE", _id } }
//   POST /bulk-single-searchs/read  body { id: <_id> }
//     200 { success: true, items: [ { status, results: { emails: [
//           { email, certainty, mxRecords, mxProvider } ] }, userData, _id } ] }
//   Statuses: NONE / SCHEDULED / IN_PROGRESS = still running; FOUND / DEBITED
//   = an email was found and the credit debited; NOT_FOUND /
//   DEBITED_NOT_FOUND = processed, nothing found; BAD_INPUT,
//   INSUFFICIENT_FUNDS, ABORTED = not analysed.
//   Certainty values seen: ultra_sure, very_sure, sure, probable.
//
// Billing (credit-cost page): /email-search 1 credit per found email;
// /domain-search 1 credit if emails were found for the domain; the
// find-people/count routes and "other routes" are free. Icypeas resolves
// Google / Microsoft catch-alls itself, so a found email is its best answer.
// Rate limits: /email-search 10 calls/sec; /bulk-single-searchs/read 30
// calls/MIN, so the poll interval below stays at 3 s.
//
// No credits endpoint is documented (the "Fetch your subscription
// information" page 404s), so "Test connection" uses the free
// /find-people/count route, which proves the key without spending.
// Input: first + last name and domain only; no LinkedIn-URL finder.

import { bareDomain, EMPTY_RESULT, FinderError, sleep, type FinderResult } from "./types";

export const ICYPEAS_BASE_URL = "https://app.icypeas.com/api";

const POLL_INTERVAL_MS = 3_000; // read route: 30 calls / minute
const POLL_BUDGET_MS = 60_000;

const RUNNING = new Set(["NONE", "SCHEDULED", "IN_PROGRESS"]);
const FOUND = new Set(["FOUND", "DEBITED"]);

// Pure: one item of the read response -> a normalised result.
// Exported for the fixture test (scripts/test-finders.ts).
export function parseIcypeasItem(item: Record<string, unknown>, searchId: string | null): FinderResult {
  const status = typeof item.status === "string" ? item.status.toUpperCase() : "";
  if (RUNNING.has(status)) return { ...EMPTY_RESULT("icypeas", "pending", status), search_id: searchId };
  const results = item.results && typeof item.results === "object" ? (item.results as Record<string, unknown>) : null;
  const emails = results && Array.isArray(results.emails) ? (results.emails as Record<string, unknown>[]) : [];
  const first = emails.find((e) => e && typeof e.email === "string" && e.email.trim());
  if (FOUND.has(status) && first) {
    const certainty = typeof first.certainty === "string" ? first.certainty : null;
    return {
      provider: "icypeas",
      status: "found",
      email: (first.email as string).trim(),
      provider_status: certainty ? `${status}/${certainty}` : status,
      credits_reported: 1,
      search_id: searchId,
    };
  }
  // NOT_FOUND / DEBITED_NOT_FOUND / BAD_INPUT / INSUFFICIENT_FUNDS / ABORTED,
  // or a FOUND with no usable address.
  return { ...EMPTY_RESULT("icypeas", "not_found", status || null), search_id: searchId, credits_reported: status === "DEBITED_NOT_FOUND" ? 1 : 0 };
}

function classify(status: number, body: string): FinderError {
  if (status === 401 || status === 403) return new FinderError("icypeas", "auth", `Icypeas rejected the API key (HTTP ${status}): ${body.slice(0, 160)}`);
  if (status === 402) return new FinderError("icypeas", "credits", `Icypeas out of credits (HTTP 402): ${body.slice(0, 160)}`);
  if (status === 429) return new FinderError("icypeas", "transient", "Icypeas rate-limited (HTTP 429)");
  return new FinderError("icypeas", "transient", `Icypeas HTTP ${status}: ${body.slice(0, 160)}`);
}

export class IcypeasClient {
  private readonly apiKey: string;
  constructor(apiKey: string) {
    this.apiKey = (apiKey || "").trim();
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.apiKey) throw new FinderError("icypeas", "auth", "Icypeas API key is not set");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${ICYPEAS_BASE_URL}${path}`, {
        method: "POST",
        headers: { Authorization: this.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new FinderError("icypeas", "transient", `Could not reach Icypeas: ${err instanceof Error ? err.message : String(err)}`);
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
      throw classify(response.status, text);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new FinderError("icypeas", "transient", "Icypeas returned a non-JSON response");
    }
    if (!data || typeof data !== "object") throw new FinderError("icypeas", "transient", "Icypeas returned an unexpected response");
    const d = data as Record<string, unknown>;
    if (d.success === false) throw new FinderError("icypeas", "transient", `Icypeas refused: ${JSON.stringify(d).slice(0, 160)}`);
    return d;
  }

  async read(searchId: string): Promise<FinderResult> {
    const data = await this.post("/bulk-single-searchs/read", { id: searchId }, 20_000);
    const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
    const item = items[0];
    if (!item) return { ...EMPTY_RESULT("icypeas", "pending", "no item yet"), search_id: searchId };
    return parseIcypeasItem(item, searchId);
  }

  // First + last name and company domain. Never calls without a name part and a domain.
  async findByNameDomain(firstName: string, lastName: string, domain: string, opts: { pollBudgetMs?: number; externalId?: string } = {}): Promise<FinderResult> {
    const f = (firstName || "").trim();
    const l = (lastName || "").trim();
    const d = bareDomain(domain);
    if ((!f && !l) || !d) return EMPTY_RESULT("icypeas", "not_found", "skipped: missing name or domain");
    const body: Record<string, unknown> = { firstname: f, lastname: l, domainOrCompany: d };
    if (opts.externalId) body.custom = { externalId: opts.externalId };
    const data = await this.post("/email-search", body, 20_000);
    const item = data.item && typeof data.item === "object" ? (data.item as Record<string, unknown>) : null;
    const id = item && typeof item._id === "string" ? item._id : "";
    if (!id) throw new FinderError("icypeas", "transient", "Icypeas did not return a search id");
    const deadline = Date.now() + (opts.pollBudgetMs ?? POLL_BUDGET_MS);
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      const r = await this.read(id);
      if (r.status !== "pending" || Date.now() > deadline) return r;
    }
  }

  // Key check for the settings button: a free count query. Returns the count
  // Icypeas reports (any number proves the key); throws a FinderError on a bad key.
  async checkKey(): Promise<number> {
    const data = await this.post("/find-people/count", { query: { jobTitles: ["Owner"] } }, 12_000);
    const n = typeof data.count === "number" ? data.count : typeof data.total === "number" ? data.total : null;
    if (n === null) {
      // The route answered without a count field: the key still authenticated.
      return 0;
    }
    return n;
  }
}
