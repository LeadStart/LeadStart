// Per-event cost constants for the UI estimate + a fallback when a run's
// usageTotalUsd isn't available yet. Actual cost is read from the Apify run's
// usageTotalUsd on completion; these are only estimates. Verified 2026-08-22.

export const PROFILE_EMAIL_COST_USD = 0.01;   // harvestapi profile + email search
export const DOMAIN_COST_USD = 0.004;         // harvestapi company (paid-tier)
export const WATERFALL_LEAD_COST_USD = 0.005; // vdrmota lead-scraped, PAID tier, per LEAD
export const WATERFALL_VERIFY_COST_USD = 0.004; // vdrmota lead-email-verified add-on, per lead
export const ACTIVITY_COST_USD = 0.005;       // harvestapi profile-posts (~0-5 posts/person; 0-result ≈ $0.001)

// Free Apify tier bills per-event pricing ~20× the paid tier (measured 2026-08-24:
// lead-scraped ~$0.10/lead free vs ~$0.005 paid). The waterfall is lead-dominated,
// so free-tier orgs pay roughly this multiple. Surfaced in the enrich dialog.
export const APIFY_FREE_TIER_MULTIPLIER = 20;

// Default directory leads pulled per company by the vdrmota waterfall. Mirrors
// DEFAULT_ENRICHMENT_SETTINGS.vdrmota_max_leads; used as the estimate fallback
// when the caller doesn't know the org's configured cap.
export const DEFAULT_WATERFALL_MAX_LEADS = 3;

export function estimateProfileCost(profiles: number): number {
  return profiles * PROFILE_EMAIL_COST_USD;
}
export function estimateDomainCost(companies: number): number {
  return companies * DOMAIN_COST_USD;
}

// The waterfall crawls PER DOMAIN and pulls up to `leadsCap` directory leads per
// domain — each lead is billed. Cost scales with domains × cap, NOT with the
// number of contacts. The old per-contact estimate under-counted ~100× (it
// multiplied contact count by a single lead price; see RESUME-WATERFALL-SETTINGS).
// `tierMultiplier` = APIFY_FREE_TIER_MULTIPLIER for a free-tier account, else 1.
export function estimateWaterfallCost(
  domains: number,
  leadsCap: number = DEFAULT_WATERFALL_MAX_LEADS,
  tierMultiplier = 1,
): number {
  const cap = Math.min(10, Math.max(1, Math.round(leadsCap)));
  return domains * cap * (WATERFALL_LEAD_COST_USD + WATERFALL_VERIFY_COST_USD) * tierMultiplier;
}
export function estimateActivityCost(people: number): number {
  return people * ACTIVITY_COST_USD;
}
