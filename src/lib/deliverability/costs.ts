// What our sending infrastructure costs us: the owner's planning cost basis.
// Pure constants, no imports, so client components (the Campaign Planner, the
// add-mailbox wizard) and tsx scripts can all read them.

/**
 * One Google Workspace seat (= one sending inbox), per month. Owner directive
 * 2026-10-03: plan on the flexible-plan rate of $8.40, NOT the $7.00 annual-
 * commitment list price. Google prorates the flexible plan by day
 * (knowledge.workspace.google.com/admin/billing/flexible-plan), so cost a
 * seat for the days it exists, not whole months.
 */
export const GOOGLE_SEAT_USD_PER_MONTH = 8.4;

/**
 * One sending domain, per year of registration. Owner planning assumption
 * 2026-10-03. Real prices are quoted live by the registrar at purchase
 * (src/lib/registrar), so treat this as the planning figure only. Not to be
 * confused with DOMAIN_COST_USD in src/lib/apify/pricing.ts, which is the
 * Apify company-domain lookup.
 */
export const SENDING_DOMAIN_USD_PER_YEAR = 11;

/** Average days in a month (365.25 / 12), for prorating monthly costs by day. */
export const AVG_DAYS_PER_MONTH = 365.25 / 12;
