// Fail-closed monthly spend cap for automated domain purchases (Phase 2).
//
// Pure logic — no I/O. The purchase route sums the org's month-to-date spend
// from sending_domains.purchase_price_usd (migration 00081) and calls
// checkSpendCap() before every registration. The guarantee: no cap set → NO
// automated purchasing (never allowed), and a purchase that would push the
// running month total over the cap is refused. Owner cap 2026-08-26: $25/mo.

export interface SpendCapDecision {
  allowed: boolean;
  reason: string;
  monthToDateUsd: number;
  capUsd: number | null;
  /** Cap minus month-to-date (before this purchase); null when no cap is set. */
  remainingUsd: number | null;
}

export function checkSpendCap(params: {
  capUsd: number | null;
  monthToDateUsd: number;
  priceUsd: number;
}): SpendCapDecision {
  const { capUsd, monthToDateUsd, priceUsd } = params;
  const remainingUsd = capUsd == null ? null : round2(capUsd - monthToDateUsd);

  if (capUsd == null) {
    return {
      allowed: false,
      reason: "No monthly spend cap is set — automated domain purchasing is disabled.",
      monthToDateUsd,
      capUsd: null,
      remainingUsd: null,
    };
  }
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) {
    return {
      allowed: false,
      reason: "Invalid purchase price.",
      monthToDateUsd,
      capUsd,
      remainingUsd,
    };
  }
  if (round2(monthToDateUsd + priceUsd) > capUsd) {
    return {
      allowed: false,
      reason: `A $${priceUsd.toFixed(2)} purchase would exceed the $${capUsd.toFixed(2)}/mo cap (already $${monthToDateUsd.toFixed(2)} spent this month).`,
      monthToDateUsd,
      capUsd,
      remainingUsd,
    };
  }
  return {
    allowed: true,
    reason: "Within the monthly cap.",
    monthToDateUsd,
    capUsd,
    remainingUsd: round2(capUsd - monthToDateUsd - priceUsd),
  };
}

/**
 * UTC first-of-month ISO timestamp for the month containing `now` — the lower
 * bound for summing this month's purchases (sending_domains where
 * created_at >= this and purchase_price_usd is not null).
 */
export function monthStartIso(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
