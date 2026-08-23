// Per-event cost constants for the UI estimate + a fallback when a run's
// usageTotalUsd isn't available yet. Actual cost is read from the Apify run's
// usageTotalUsd on completion; these are only estimates. Verified 2026-08-22.

export const PROFILE_EMAIL_COST_USD = 0.01;   // harvestapi profile + email search
export const DOMAIN_COST_USD = 0.004;         // harvestapi company (paid-tier)
export const WATERFALL_LEAD_COST_USD = 0.005; // vdrmota lead-scraped (paid-tier)
export const WATERFALL_VERIFY_COST_USD = 0.004; // vdrmota lead-email-verified add-on (decisive only)
export const ACTIVITY_COST_USD = 0.005;       // harvestapi profile-posts (~0-5 posts/person; 0-result ≈ $0.001)

export function estimateProfileCost(profiles: number): number {
  return profiles * PROFILE_EMAIL_COST_USD;
}
export function estimateDomainCost(companies: number): number {
  return companies * DOMAIN_COST_USD;
}
export function estimateWaterfallCost(leads: number): number {
  return leads * (WATERFALL_LEAD_COST_USD + WATERFALL_VERIFY_COST_USD);
}
export function estimateActivityCost(people: number): number {
  return people * ACTIVITY_COST_USD;
}
