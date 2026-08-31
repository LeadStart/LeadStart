import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { priceDelivered, worstCaseRetailPerRow, type PricingTier, type SearchKind } from "./pricing-math";

// Re-export the pure pricing math so billing.ts stays the single import surface.
export { tierPrice, priceDelivered, worstCaseRetailPerRow, capRunCharge } from "./pricing-math";
export type { PricingTier, SearchKind } from "./pricing-math";

// Token billing: reserve -> cap -> settle (Phase 3 of the token product).
//
// Cash-safety model (D2/D4):
//  - At buyer search creation we `hold` worst-case retail tokens against the
//    buyer's available balance (rejecting the search if they can't cover it),
//    and cap the actor at the worst-case vendor cost.
//  - At settlement (finalizeOutcomes, which can run several times per search as
//    enrichment drains across runs) we RECOMPUTE the charge from the search's
//    CUMULATIVE delivered_counts and upsert a single `charge` + `release` pair.
//    Recompute-and-upsert is idempotent-and-additive by construction, which
//    resolves the "one settlement row per search but many enrichment runs"
//    tension: each run re-settles to the current cumulative delivered total.
//  - Only searches that carry a `hold` are billed. Agency (kind='agency')
//    searches never get a hold, so this layer is a no-op for them.
//
// Charging is attribute-based ("charge off outcome_counts x price card"): a
// delivered lead pays for each delivered attribute it earned (owner name,
// personal email, verification), summed. `record` is free and `catch_all_guess`
// is bundled, so neither is charged; `phone` has no price tier.

type Admin = ReturnType<typeof createAdminClient>;

export interface TokenBalance {
  available: number;
  held: number;
}

export async function loadPricingTiers(admin: Admin): Promise<PricingTier[]> {
  const { data } = await admin
    .from("token_price_tiers")
    .select("vein, tier_key, token_price, is_free, is_bundled");
  return (data as PricingTier[]) ?? [];
}

export async function loadPricingConfig(
  admin: Admin,
): Promise<{ version: number; max_charge_per_run_usd: number | null; max_rows_per_search: number | null }> {
  const { data } = await admin
    .from("token_pricing_config")
    .select("version, max_charge_per_run_usd, max_rows_per_search")
    .eq("singleton", true)
    .maybeSingle();
  const c = data as { version?: number; max_charge_per_run_usd?: number | null; max_rows_per_search?: number | null } | null;
  return {
    version: c?.version ?? 1,
    max_charge_per_run_usd: c?.max_charge_per_run_usd ?? null,
    max_rows_per_search: c?.max_rows_per_search ?? null,
  };
}

/**
 * The owner's global per-run vendor-cost ceiling (max_charge_per_run_usd), or
 * null when unset. Read by the sourcing/enrichment crons to clamp their computed
 * per-run maxTotalChargeUsd via capRunCharge. Never throws.
 */
export async function loadMaxChargeCeiling(admin: Admin): Promise<number | null> {
  try {
    const { data } = await admin
      .from("token_pricing_config")
      .select("max_charge_per_run_usd")
      .eq("singleton", true)
      .maybeSingle();
    const v = (data as { max_charge_per_run_usd?: number | null } | null)?.max_charge_per_run_usd;
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

export async function getBalance(admin: Admin, organizationId: string): Promise<TokenBalance> {
  const { data } = await admin
    .from("token_balances")
    .select("available, held")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const b = data as { available?: number | null; held?: number | null } | null;
  return { available: Number(b?.available ?? 0), held: Number(b?.held ?? 0) };
}

export interface HoldResult {
  ok: boolean;
  held: number;
  reason?: "pricing_not_configured" | "insufficient_tokens" | "error";
  available?: number;
  message?: string;
}

/**
 * Reserve worst-case retail tokens for a buyer search. Rejects (without
 * inserting) if pricing isn't configured or the buyer can't cover the hold.
 * Idempotent: a duplicate hold for the same search is swallowed.
 */
export async function placeHold(
  admin: Admin,
  opts: { organizationId: string; searchId: string; searchKind: SearchKind; targetMaxResults: number },
): Promise<HoldResult> {
  const tiers = await loadPricingTiers(admin);
  const perRow = worstCaseRetailPerRow(tiers, opts.searchKind);
  if (perRow <= 0) return { ok: false, held: 0, reason: "pricing_not_configured" };

  const held = Math.ceil(perRow * Math.max(0, opts.targetMaxResults));
  const { available } = await getBalance(admin, opts.organizationId);
  if (available < held) return { ok: false, held, reason: "insufficient_tokens", available };

  const { error } = await admin.from("token_ledger").insert({
    organization_id: opts.organizationId,
    entry_type: "hold",
    tokens: held,
    search_id: opts.searchId,
    search_kind: opts.searchKind,
  } as Record<string, unknown>);
  if (error && !/duplicate key|unique/i.test(error.message)) {
    return { ok: false, held, reason: "error", message: error.message };
  }
  return { ok: true, held };
}

async function upsertLedgerBySearchType(
  admin: Admin,
  row: { organization_id: string; entry_type: "charge" | "release"; tokens: number; search_id: string; search_kind: SearchKind; price_card_version?: number | null },
) {
  // UPDATE-then-INSERT so re-settlement (multiple enrichment runs per search)
  // recomputes rather than appends. The UNIQUE(search_id, entry_type) index
  // catches a concurrent double-insert, which we swallow.
  const { data: updated } = await admin
    .from("token_ledger")
    .update({ tokens: row.tokens, price_card_version: row.price_card_version ?? null } as Record<string, unknown>)
    .eq("search_id", row.search_id)
    .eq("entry_type", row.entry_type)
    .select("id");
  if (updated && updated.length > 0) return;
  const { error } = await admin.from("token_ledger").insert(row as Record<string, unknown>);
  if (error && !/duplicate key|unique/i.test(error.message)) throw new Error(error.message);
}

export interface SettleResult {
  charged: number;
  released: number;
}

/**
 * Settle a buyer search: charge its cumulative delivered outcomes, release the
 * unspent hold. No-op (returns null) for searches without a hold (agency
 * searches). Idempotent + additive across enrichment runs via recompute+upsert.
 */
export async function settleSearch(
  admin: Admin,
  opts: { searchId: string; searchKind: SearchKind; deliveredCounts: Record<string, unknown> | null | undefined },
): Promise<SettleResult | null> {
  const { data: holdRow } = await admin
    .from("token_ledger")
    .select("tokens, organization_id")
    .eq("search_id", opts.searchId)
    .eq("entry_type", "hold")
    .maybeSingle();
  const hold = holdRow as { tokens: number; organization_id: string } | null;
  if (!hold) return null; // not a buyer search — nothing to settle

  const held = Number(hold.tokens);
  const [tiers, config] = await Promise.all([loadPricingTiers(admin), loadPricingConfig(admin)]);
  const rawCharge = Math.ceil(priceDelivered(tiers, opts.searchKind, opts.deliveredCounts));
  const charged = Math.min(held, Math.max(0, rawCharge)); // never charge past the hold
  const released = Math.max(0, held - charged);

  await upsertLedgerBySearchType(admin, {
    organization_id: hold.organization_id,
    entry_type: "charge",
    tokens: charged,
    search_id: opts.searchId,
    search_kind: opts.searchKind,
    price_card_version: config.version,
  });
  await upsertLedgerBySearchType(admin, {
    organization_id: hold.organization_id,
    entry_type: "release",
    tokens: released,
    search_id: opts.searchId,
    search_kind: opts.searchKind,
  });

  return { charged, released };
}
