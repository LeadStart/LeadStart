// Delivered-outcome classification — the margin ledger's unit of account. Pure +
// recomputable from a contact's final columns (no new per-contact writes): the
// enrichment run classifies each contact at completion and rolls the counts up
// onto the run (outcome_counts) and the source search (delivered_counts). Future
// self-serve billing prices these tiers against the run's cost_usd.
//
// Tiers mirror the outcome-tiered price card (record → +generic email → +owner
// name → +verified personal email). Flags are NOT mutually exclusive — a lead can
// carry a phone, a company email, an owner name, and a verified personal email at
// once — so billing can price whichever tier it charges for.

export interface OutcomeInput {
  email: string | null;
  emailVerificationStatus: string | null; // MV verdict on contacts.email ('ok' | …)
  emailKind: string | null; // enrichment_data.enrichment.email.kind ('company_generic' for a backfilled inbox)
  companyEmail: string | null;
  companyPhone: string | null;
  phone: string | null;
  firstName: string | null;
}

export interface OutcomeFlags {
  record: boolean; // every saved lead (the base tier)
  phone: boolean; // a company or personal phone
  company_email: boolean; // a generic company inbox (info@/…)
  owner_name: boolean; // a decision-maker name
  personal_email: boolean; // a person-shaped email on contacts.email (not a backfilled generic)
  verified_email: boolean; // that personal email verified clean by Million Verifier
}

export const OUTCOME_KEYS: (keyof OutcomeFlags)[] = [
  "record",
  "phone",
  "company_email",
  "owner_name",
  "personal_email",
  "verified_email",
];

// Mutually exclusive "best tier delivered" per lead — what a donut/radial can
// chart (the flags above overlap, so exclusive segments can't be derived from
// their aggregates). Priority: personal email > company inbox > phone > nothing.
export const TIER_KEYS = ["tier_personal", "tier_company", "tier_phone", "tier_none"] as const;
export type TierKey = (typeof TIER_KEYS)[number];

export function bestTier(flags: OutcomeFlags): TierKey {
  if (flags.personal_email) return "tier_personal";
  if (flags.company_email) return "tier_company";
  if (flags.phone) return "tier_phone";
  return "tier_none";
}

// Every key addOutcome can write — merge loops must cover all of these.
export const ALL_COUNT_KEYS: readonly string[] = [...OUTCOME_KEYS, ...TIER_KEYS];

export function classifyContactOutcome(c: OutcomeInput): OutcomeFlags {
  // A backfilled generic inbox lives on contacts.email but is NOT a personal
  // email — it counts as company_email, not personal_email.
  const isBackfilledGeneric = Boolean(c.email) && c.emailKind === "company_generic";
  const personalEmail = Boolean(c.email) && !isBackfilledGeneric;
  const verifiedEmail = personalEmail && c.emailVerificationStatus === "ok";
  const companyEmail = Boolean(c.companyEmail) || isBackfilledGeneric;
  return {
    record: true,
    phone: Boolean(c.phone) || Boolean(c.companyPhone),
    company_email: companyEmail,
    owner_name: Boolean(c.firstName),
    personal_email: personalEmail,
    verified_email: verifiedEmail,
  };
}

// Accumulate flags into a running count map: adds 1 per true flag, plus 1 to the
// lead's exclusive best-tier bucket (the radial's data).
export function addOutcome(counts: Record<string, number>, flags: OutcomeFlags): void {
  for (const k of OUTCOME_KEYS) {
    if (flags[k]) counts[k] = (counts[k] ?? 0) + 1;
  }
  const tier = bestTier(flags);
  counts[tier] = (counts[tier] ?? 0) + 1;
}
