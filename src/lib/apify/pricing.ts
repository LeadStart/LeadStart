// Per-event cost constants for the UI estimate + a fallback when a run's
// usageTotalUsd isn't available yet. Actual cost is read from the Apify run's
// usageTotalUsd on completion; these are only estimates. Verified 2026-08-22.

export const PROFILE_EMAIL_COST_USD = 0.01;   // harvestapi profile + email search
export const DOMAIN_COST_USD = 0.004;         // harvestapi company (paid-tier)
export const WATERFALL_LEAD_COST_USD = 0.005; // generic apify-waterfall per-item fallback (paid tier)
export const ACTIVITY_COST_USD = 0.005;       // harvestapi profile-posts (~0-5 posts/person; 0-result ≈ $0.001)

// Approx cost of ONE Million Verifier credit (used to tally pattern_mv per-item
// cost). MV is a prepaid pool, not per-call metered like Apify, so this is a
// rough unit price — ~$0.004 per contact worst case (≤6 candidates, catch-all +
// unknown are free). Pattern_mv typically resolves in 1–3 charged credits.
export const MV_CREDIT_COST_USD = 0.0007;

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

export function estimateProfileCost(profiles: number): number {
  return profiles * PROFILE_EMAIL_COST_USD;
}
export function estimateDomainCost(companies: number): number {
  return companies * DOMAIN_COST_USD;
}
export function estimateActivityCost(people: number): number {
  return people * ACTIVITY_COST_USD;
}
