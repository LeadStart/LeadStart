// Datagma email finder client (pay-per-hit, under test; not in the cron).
//
// Contract, from Datagma's own docs, read 2026-10-12:
//   https://datagma.com/en/api                       (endpoints + billing)
//   https://datagmaapi.readme.io/reference/ingressservice_findemailv8.md
//   https://datagmaapi.readme.io/reference/find-work-email-address.md
//   https://datagmaapi.readme.io/reference/ingressservice_getcredit.md
//
// Auth: the key is the `apiId` QUERY parameter on every call (no header).
// Base https://gateway.datagma.net/api/ingress. All calls are GET and
// SYNCHRONOUS.
//
//   GET /v8/findEmail?apiId=&fullName=&company=   (company = domain or name;
//       firstName + lastName accepted instead of fullName; linkedInSlug =
//       the COMPANY LinkedIn URL, optional)
//     200 { email, emailDomain, status, patterns[], mxfound, smtpCheck,
//           cachAll }                                (sic: "cachAll")
//   GET /v1/mine?apiId=   -> remaining balance (schema lists `id`; the
//       description names `currentCredit` and `plan`; both read below)
//
// Billing (api page + pricing): 1 credit = 1 verified email; "No match = no
// credit used"; unverifiable catch-alls are returned labelled "Most Probable"
// and are NOT billed. The response `status` is not enumerated in the spec, so
// the parser below keys on the fields that are: an email with smtpCheck true
// (or a status saying verified) is found; an email with cachAll true or a
// status containing "probable" is catch_all; no email is not_found. The
// harness records the raw status so the real vocabulary can be pinned on the
// first live run.
// Free tier: 100 credits/month, API included, catch-all free on paid plans
// (the free plan's API line does not say). No LinkedIn PROFILE finder: the
// slug parameter is the company page, so pass 2 is not available here.

import { bareDomain, EMPTY_RESULT, FinderError, type FinderResult } from "./types";

export const DATAGMA_BASE_URL = "https://gateway.datagma.net/api/ingress";

// Pure: the 200 body of /v8/findEmail -> a normalised result.
// Exported for the fixture test (scripts/test-finders.ts).
export function parseDatagmaResult(data: Record<string, unknown>): FinderResult {
  const email = typeof data.email === "string" ? data.email.trim() : "";
  const status = typeof data.status === "string" ? data.status : null;
  const smtp = data.smtpCheck === true;
  const catchAll = data.cachAll === true || data.catchAll === true;
  const label = [status, catchAll ? "catch-all" : null, smtp ? "smtp-ok" : null].filter(Boolean).join("/") || null;
  if (!email) return EMPTY_RESULT("datagma", "not_found", label);
  const probable = /probable/i.test(status ?? "");
  if (catchAll || probable) {
    return { provider: "datagma", status: "catch_all", email, provider_status: label, credits_reported: 0, search_id: null };
  }
  return { provider: "datagma", status: "found", email, provider_status: label, credits_reported: 1, search_id: null };
}

function classify(status: number, body: string): FinderError {
  if (status === 401 || status === 403) return new FinderError("datagma", "auth", `Datagma rejected the API key (HTTP ${status}): ${body.slice(0, 160)}`);
  if (status === 402) return new FinderError("datagma", "credits", `Datagma out of credits (HTTP 402): ${body.slice(0, 160)}`);
  if (status === 429) return new FinderError("datagma", "transient", "Datagma rate-limited (HTTP 429)");
  return new FinderError("datagma", "transient", `Datagma HTTP ${status}: ${body.slice(0, 160)}`);
}

export class DatagmaClient {
  private readonly apiKey: string;
  constructor(apiKey: string) {
    this.apiKey = (apiKey || "").trim();
  }

  private async get(path: string, params: Record<string, string>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.apiKey) throw new FinderError("datagma", "auth", "Datagma API key is not set");
    const qs = new URLSearchParams({ apiId: this.apiKey, ...params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${DATAGMA_BASE_URL}${path}?${qs.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      throw new FinderError("datagma", "transient", `Could not reach Datagma: ${err instanceof Error ? err.message : String(err)}`);
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
      throw new FinderError("datagma", "transient", "Datagma returned a non-JSON response");
    }
    if (!data || typeof data !== "object") throw new FinderError("datagma", "transient", "Datagma returned an unexpected response");
    return data as Record<string, unknown>;
  }

  // Full name + company domain. Never calls without both.
  async findByNameDomain(fullName: string, domain: string): Promise<FinderResult> {
    const n = (fullName || "").trim();
    const d = bareDomain(domain);
    if (!n || !d) return EMPTY_RESULT("datagma", "not_found", "skipped: missing name or domain");
    const data = await this.get("/v8/findEmail", { fullName: n, company: d }, 45_000);
    return parseDatagmaResult(data);
  }

  // Balance, for the settings "Test connection" button. Free.
  async remainingCredits(): Promise<number> {
    const data = await this.get("/v1/mine", {}, 12_000);
    for (const key of ["currentCredit", "credits", "credit", "id"]) {
      const v = data[key];
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
    }
    throw new FinderError("datagma", "transient", "Datagma balance response has no credit field");
  }
}
