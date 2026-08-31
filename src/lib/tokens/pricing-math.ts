// Pure token-pricing math (no DB, no server-only) so it is unit-testable and
// safe to import anywhere. The DB-touching reserve/settle logic lives in
// billing.ts, which re-exports these.

export interface PricingTier {
  vein: string;
  tier_key: string;
  token_price: number | null;
  is_free: boolean;
  is_bundled: boolean;
}

export type SearchKind = "maps" | "linkedin";

// The engine's delivered-outcome keys (src/lib/enrichment/outcomes.ts
// OUTCOME_KEYS) mapped to the token_price_tiers.tier_key they bill against.
// `record` (free), `catch_all_email` (bundled -> catch_all_guess), and `phone`
// (no tier) are intentionally absent. `catch_all_recovered` (Findymail) has no
// engine outcome key and is settled separately once recovery detection lands.
export const ENGINE_KEY_TO_TIER: Record<string, string> = {
  company_email: "company_inbox",
  owner_name: "owner_name",
  personal_email: "personal_email",
  verified_email: "verified_personal_email",
};

/** Token price for a priced tier (0 for free / bundled / unpriced / missing). */
export function tierPrice(tiers: PricingTier[], vein: string, tierKey: string): number {
  const t = tiers.find((x) => x.vein === vein && x.tier_key === tierKey);
  if (!t || t.is_free || t.is_bundled || t.token_price == null) return 0;
  const n = Number(t.token_price);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Retail tokens to charge for a search's cumulative delivered outcomes. */
export function priceDelivered(
  tiers: PricingTier[],
  vein: string,
  deliveredCounts: Record<string, unknown> | null | undefined,
): number {
  if (!deliveredCounts) return 0;
  let total = 0;
  for (const [engineKey, tierKey] of Object.entries(ENGINE_KEY_TO_TIER)) {
    const count = Number(deliveredCounts[engineKey] ?? 0);
    if (Number.isFinite(count) && count > 0) {
      total += count * tierPrice(tiers, vein, tierKey);
    }
  }
  return total;
}

/**
 * Worst-case retail tokens a single delivered row could cost — the hold basis
 * per row. A row follows ONE path: the fully-loaded personal path (owner name +
 * personal email + verified) is the realistic max; company-inbox and
 * catch-all-recovered are cheaper alternatives. Max of those is a tight but safe
 * upper bound (over-holding is safe — it's released; under-holding is not).
 */
export function worstCaseRetailPerRow(tiers: PricingTier[], vein: string): number {
  const personalLoad =
    tierPrice(tiers, vein, "owner_name") +
    tierPrice(tiers, vein, "personal_email") +
    tierPrice(tiers, vein, "verified_personal_email");
  return Math.max(
    personalLoad,
    tierPrice(tiers, vein, "company_inbox"),
    tierPrice(tiers, vein, "catch_all_recovered"),
  );
}
