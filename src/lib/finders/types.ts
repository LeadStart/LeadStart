// Shared shapes for the pay-per-hit email finders under test (Enrow, Icypeas,
// Datagma; Findymail has its own older client in src/lib/findymail). One find
// outcome per lookup, one typed error taxonomy, so the test harness can tally
// every provider the same way: hits, misses, credits actually charged.
//
// None of these clients is wired into the enrichment cron. They are read by
// scripts/finder-test.mts and the settings "Test connection" routes only.

export type FinderId = "enrow" | "icypeas" | "datagma";

export type FinderErrorKind = "auth" | "credits" | "blocked" | "transient";

// `definitive` (auth/credits/blocked) means "stop calling this provider for the
// run"; `transient` (network, 5xx, timeout, rate limit) means try again later.
export class FinderError extends Error {
  readonly provider: FinderId;
  readonly kind: FinderErrorKind;
  readonly definitive: boolean;
  constructor(provider: FinderId, kind: FinderErrorKind, message: string) {
    super(message);
    this.name = "FinderError";
    this.provider = provider;
    this.kind = kind;
    this.definitive = kind !== "transient";
  }
}

// What a lookup produced, normalised across providers.
//   found        a deliverable email came back (the provider's own "valid")
//   catch_all    the provider returned an address it could not fully confirm
//                (Datagma's "Most Probable"; Enrow and Icypeas resolve these
//                into found / not_found themselves, so they never emit it)
//   not_found    processed, no email
//   pending      still running after the poll budget (async providers)
export type FinderStatus = "found" | "catch_all" | "not_found" | "pending";

export interface FinderResult {
  provider: FinderId;
  status: FinderStatus;
  email: string | null;
  // The provider's own label for the result, verbatim (Enrow qualification,
  // Icypeas status + certainty, Datagma status), kept for the test report.
  provider_status: string | null;
  // Credits the provider says this lookup cost, when it reports it (Enrow's
  // credits_used); null when the provider does not say per call.
  credits_reported: number | null;
  // Provider's search id, for re-reading an async result later.
  search_id: string | null;
}

export const EMPTY_RESULT = (provider: FinderId, status: FinderStatus, provider_status: string | null = null): FinderResult => ({
  provider,
  status,
  email: null,
  provider_status,
  credits_reported: null,
  search_id: null,
});

// Lower-case the domain and strip scheme / www / path, the way the Findymail
// client does, so every provider gets the same bare domain.
export function bareDomain(domain: string | null | undefined): string {
  return (domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
