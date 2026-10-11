// Generic company inbox (info@/contact@) on contacts.email: the shared rules for
// the two paths that put one there. Pure module.
//
// 1. Name-less leads (always): finishWaterfallMiss backfills the scraped inbox,
//    because a business with no person has no other address to send to.
// 2. Named leads, opt-in (the company_inbox_fallback add-on, 2026-10-11): when
//    the waterfall ends with no personal email, the cron's company-inbox pass
//    promotes contacts.company_email onto contacts.email. Without the add-on a
//    named lead keeps the person-only contract (migration 00076), which the
//    TuBe handoff relies on.
//
// Both write the same provenance, so the address stays tiered "company"
// (email-tier.ts), is never sold or handed off as a personal email, and still
// reaches the verify phase for its first Million Verifier verdict.

// Low confidence on purpose: a shared inbox, not the decision-maker's own.
export const COMPANY_INBOX_CONFIDENCE = 30;

// The enrichment_data.enrichment.email block for a generic inbox on
// contacts.email. Only our site scrape ever fills contacts.company_email, so the
// provider is always site_scrape. `via` marks a named lead's opt-in promotion,
// so those can be told apart from the name-less backfill.
export function companyInboxProvenance(
  email: string,
  foundAt: string,
  via?: "company_inbox_fallback",
): Record<string, unknown> {
  return {
    provider: "site_scrape",
    kind: "company_generic",
    email,
    confidence: COMPANY_INBOX_CONFIDENCE,
    found_at: foundAt,
    ...(via ? { via } : {}),
  };
}

// Which of a run's contacts get the named-lead fallback, stored on the run's
// waterfall_config snapshot as `company_inbox_fallback`:
//   "all"      → every contact in the run (Contacts → Enrich with the box ticked:
//                the owner picked these contacts and asked for it).
//   "opted_in" → only contacts whose enrichment_data.addons stamp opted in (an
//                auto-enqueued run is an OR-merge over its contacts, so one
//                opted-in contact must not turn it on for strangers).
// Absent (every run before this add-on, and runs nobody opted into) → off.
export type CompanyInboxFallbackScope = "all" | "opted_in";

export function companyInboxFallbackScope(runConfig: unknown): CompanyInboxFallbackScope | null {
  const v =
    runConfig && typeof runConfig === "object"
      ? (runConfig as { company_inbox_fallback?: unknown }).company_inbox_fallback
      : undefined;
  return v === "all" || v === "opted_in" ? v : null;
}
