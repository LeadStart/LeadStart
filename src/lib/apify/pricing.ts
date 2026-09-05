// Per-event cost constants for the UI estimate + a fallback when a run's
// usageTotalUsd isn't available yet. Actual cost is read from the Apify run's
// usageTotalUsd on completion; these are only estimates. Verified 2026-08-22.

export const PROFILE_EMAIL_COST_USD = 0.01;   // harvestapi profile + email search
export const DOMAIN_COST_USD = 0.004;         // harvestapi company (paid-tier)
export const WATERFALL_LEAD_COST_USD = 0.005; // generic apify-waterfall per-item fallback (paid tier)
// harvestapi profile-posts. We hard-cap maxPosts:1, so the true per-person worst
// case is 1 post x $0.002/post (a 0-result profile bills ~$0.001). SPEND-34.
export const ACTIVITY_COST_USD = 0.002;

// LinkedIn profile-search sourcing depth rates (harvestapi~linkedin-profile-search),
// used as BRONZE-tier fallbacks when live pricing can't be read. The actor bills
// per RESULTS PAGE, not per kept profile: Short = $0.10/page / 25 = $0.004/profile;
// Full opens each profile (+$0.004); Full+email adds the email lookup (~+$0.01).
// Single source for the panel DEPTHS + the live-pricing/route fallbacks. SPEND-35.
export const SOURCING_SHORT_USD = 0.004;
export const SOURCING_FULL_USD = 0.008;
export const SOURCING_FULL_EMAIL_USD = 0.014;

// Cost of ONE Million Verifier credit at the org's purchase tier. MV is a
// prepaid tiered pool ($37/10K ≈ $0.0037 … $549/1M ≈ $0.00055, verified
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
// events. Measured real (12 runs, 52 sites) = $0.0026/site; browser-tier
// escalation can reach ~$0.01/site. This is the SINGLE per-domain estimate, set to
// the same measured value the live path uses so both agree (SPEND-29). Actual cost
// is read from the run's usageTotalUsd; a managed-unblocker (tier 5) adds a charge.
export const SITE_SCRAPE_COST_USD = 0.003;
export function estimateScrapeCost(domains: number): number {
  return domains * SITE_SCRAPE_COST_USD;
}

// bovi (the pay-per-found Apify pattern finder, opt-in fallback). Billed per
// found email (pay-on-hit). Verified live at our BRONZE tier 2026-08-30:
// $0.004851/found; the real cost is read from usageTotalUsd on completion. SPEND-30.
export const BOVI_COST_USD = 0.005;
export function estimateBoviCost(domains: number): number {
  return domains * BOVI_COST_USD;
}

// Name-to-domain discovery (web lookup for companies with no LinkedIn page).
// Perplexity Sonar ONLY since 2026-08-28 (the Claude web_search fallback was
// removed). Honest ceiling: ~$0.0005 in tokens plus Perplexity's per-request
// search fee; the homepage-confirmation fetch is free. NOTE: the cost accrued
// onto the run is token-only (calculateCost), so it undercounts the per-request
// search fee, the same known simplification as the decision-maker layer.
export const DOMAIN_DISCOVERY_COST_USD = 0.005;
export function estimateDomainDiscoveryCost(companies: number): number {
  return companies * DOMAIN_DISCOVERY_COST_USD;
}

// Owner-name (naming) discovery: decision-maker Layer 1 (Haiku site scrape) plus
// optional Layer 2 (Perplexity Sonar web search ONLY since 2026-08-28; no Claude
// fallback, so no key = Layer 2 no-ops) per business. Honest ceiling: Layer 1 is
// ~$0.003-0.01 in tokens, Layer 2 adds ~$0.005-0.015 when it fires; the site
// fetch is free. Token-only accrual undercounts per-request search fees, so this
// is the estimate ceiling.
export const NAMING_COST_USD = 0.015;
export function estimateNamingCost(businesses: number): number {
  return businesses * NAMING_COST_USD;
}

// Findymail catch-all validation (pay-on-HIT). When pattern_mv is blind on a
// catch-all domain, Findymail's finder recovers a genuinely deliverable address
// and charges 1 credit ONLY when it returns one (misses / risky catch-alls cost
// nothing, bounces are refunded). Entry tier $49/1k = $0.049/hit; bulk $249/15k
// ≈ $0.017/hit. This entry-tier per-HIT rate is the estimate ceiling: since
// only the catch-all subset is validated and misses are free, real spend is
// typically well under (leads × rate).
export const FINDYMAIL_CATCHALL_COST_USD = 0.049;
export function estimateCatchAllValidationCost(catchAllLeads: number): number {
  return catchAllLeads * FINDYMAIL_CATCHALL_COST_USD;
}

// compass business-leads add-on (`lead-scraped` event): $0.0075 per person
// successfully extracted, pay-on-HIT (68/100 zero-lead places charged $0 in the
// 2026-08-30 probe), but one "hit" is one PERSON and the actor's cap input
// (maximumLeadsEnrichmentRecords) is PER PLACE, not per run; an uncapped chain
// dumps whole rosters (the $14.17 probe lesson). We always send the per-place
// cap below, so max exposure = places × cap × price.
export const MAPS_LEAD_COST_USD = 0.0075;
export const MAPS_LEADS_PER_PLACE = 3;
export function estimateMapsLeadsCost(places: number): number {
  return places * MAPS_LEADS_PER_PLACE * MAPS_LEAD_COST_USD; // ceiling, not expectation
}

// Google Maps place record (compass~google-maps-extractor `place-scraped` event).
// Tiered FREE $0.005 → DIAMOND $0.0008; this BRONZE/Starter midpoint is the
// estimate: actual cost is read from the run's usageTotalUsd. Filter events
// (min-rating / website filter) add ~$0.001/place each when used.
export const MAPS_PLACE_COST_USD = 0.004;
export function estimateMapsPlaceCost(places: number): number {
  return places * MAPS_PLACE_COST_USD;
}

// compass `filter-applied` event: $0.001 per place, per active filter (website /
// min-rating / category). BRONZE-tier fallback when the live filter price can't be
// read; the Maps DIY estimate adds one of these per filter it sends. SPEND-25.
export const MAPS_FILTER_COST_USD = 0.001;

export function estimateProfileCost(profiles: number): number {
  return profiles * PROFILE_EMAIL_COST_USD;
}
export function estimateDomainCost(companies: number): number {
  return companies * DOMAIN_COST_USD;
}
export function estimateActivityCost(people: number): number {
  return people * ACTIVITY_COST_USD;
}
