// Per-event cost constants for the UI estimate + a fallback when a run's
// usageTotalUsd isn't available yet. Actual cost is read from the Apify run's
// usageTotalUsd on completion; these are only estimates. Verified 2026-08-22.

export const PROFILE_EMAIL_COST_USD = 0.01;   // harvestapi profile + email search
export const DOMAIN_COST_USD = 0.004;         // harvestapi company (paid-tier)
export const WATERFALL_LEAD_COST_USD = 0.005; // generic apify-waterfall per-item fallback (paid tier)
export const ACTIVITY_COST_USD = 0.005;       // harvestapi profile-posts (~0-5 posts/person; 0-result ≈ $0.001)

// Cost of ONE Million Verifier credit at the org's purchase tier. MV is a
// prepaid tiered pool ($37/10K ≈ $0.0037 … $549/1M ≈ $0.00055 — verified
// against MV pricing 2026-08-25); owner call 2026-08-25: assume the 10K
// pay-as-you-go bundle until purchasing changes. Pattern_mv typically resolves
// in 1–3 charged credits (~$0.004–0.011/contact; ≤6 worst case ≈ $0.022;
// catch-all + unknown verdicts are free).
export const MV_CREDIT_COST_USD = 0.0037;

// Estimate for the pattern_mv method (the default): contacts × ~6 candidate
// checks × unit price, an honest upper bound (most resolve in far fewer).
export const PATTERN_MV_MAX_CREDITS_PER_CONTACT = 6;
export function estimatePatternMvCost(contacts: number): number {
  return contacts * PATTERN_MV_MAX_CREDITS_PER_CONTACT * MV_CREDIT_COST_USD;
}

// site_scrape (our own actor) bills raw Apify COMPUTE per site, not per-lead
// events: ~$0.002–0.01/site depending on whether the browser tier fires. This
// midpoint is a per-domain estimate band; the actual cost is read from the run's
// usageTotalUsd. A managed-unblocker request (tier 5) would add its own charge.
export const SITE_SCRAPE_COST_USD = 0.006;
export function estimateScrapeCost(domains: number): number {
  return domains * SITE_SCRAPE_COST_USD;
}

// bovi (the pay-per-found Apify pattern finder, opt-in fallback). Billed per
// found email; free-tier price unverified, so this is a rough per-domain band —
// the real cost is read from usageTotalUsd on completion.
export const BOVI_COST_USD = 0.02;
export function estimateBoviCost(domains: number): number {
  return domains * BOVI_COST_USD;
}

// Name→domain discovery (web lookup for companies with no LinkedIn page). Honest
// ceiling: a Perplexity Sonar call is ~$0.0005 in tokens but Perplexity also
// bills a per-request search fee, and the Claude web_search fallback runs
// ~$0.01–0.015/lookup ($10/1k searches + tokens); the homepage-confirmation fetch
// is free. NOTE: the cost accrued onto the run is token-only (calculateCost),
// so it undercounts the per-request search fee — same known simplification as
// the decision-maker layer, surfaced here as the estimate ceiling.
export const DOMAIN_DISCOVERY_COST_USD = 0.005;
export function estimateDomainDiscoveryCost(companies: number): number {
  return companies * DOMAIN_DISCOVERY_COST_USD;
}

export function estimateProfileCost(profiles: number): number {
  return profiles * PROFILE_EMAIL_COST_USD;
}
export function estimateDomainCost(companies: number): number {
  return companies * DOMAIN_COST_USD;
}
export function estimateActivityCost(people: number): number {
  return people * ACTIVITY_COST_USD;
}
