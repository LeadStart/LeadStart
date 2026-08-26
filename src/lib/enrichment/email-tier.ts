// Email-outcome tier for a lead — the shared display/sort order for finished
// lists (owner ruling 2026-08-26): direct person email first, company inbox
// second, catch-all guesses third, everything else last. Pure module so the
// Contacts table, both Prospecting panels, and any future list share one
// definition instead of re-deriving it.

export type EmailTier = "person" | "company" | "catch_all" | "none";

export const EMAIL_TIER_RANK: Record<EmailTier, number> = {
  person: 0,
  company: 1,
  catch_all: 2,
  none: 3,
};

export interface EmailTierInput {
  email: string | null | undefined;
  company_email?: string | null;
  // enrichment_data.enrichment.email.kind — 'company_generic' when contacts.email
  // holds a scraped generic inbox (the documented 00076 backfill exception).
  email_kind?: string | null;
  // enrichment_data.enrichment.email.provider_status — 'catch_all' when the
  // address is a pattern guess on a catch-all domain (confidence 40, unprovable).
  email_provider_status?: string | null;
  // Send-time / verify-phase Million Verifier verdict cached on the contact
  // (migration 00069) — 'catch_all' marks the same condition detected later.
  email_verification_subresult?: string | null;
}

// A present email is a person email unless provenance says otherwise: a
// catch-all guess is its own tier (never sold/sorted as verified-personal), and
// a backfilled generic inbox is company-tier even though it lives on
// contacts.email. With no email at all, a company_email reference still makes
// the lead mailable-ish → company tier.
export function classifyEmailTier(c: EmailTierInput): EmailTier {
  if (c.email) {
    // Generic-inbox kind wins over catch-all provenance (matches
    // classifyContactOutcome): a scraped inbox is a real address, not a guess.
    if (c.email_kind === "company_generic") return "company";
    if (c.email_provider_status === "catch_all" || c.email_verification_subresult === "catch_all") {
      return "catch_all";
    }
    return "person";
  }
  if (c.company_email) return "company";
  return "none";
}

export function emailTierRank(c: EmailTierInput): number {
  return EMAIL_TIER_RANK[classifyEmailTier(c)];
}

// Display metadata for the non-trivial tiers (UI badges). 'person' and 'none'
// rows usually need no badge — the email itself / the dash says it.
export const EMAIL_TIER_LABEL: Record<EmailTier, string> = {
  person: "Personal email",
  company: "Company inbox",
  catch_all: "Catch-all",
  none: "No email",
};
