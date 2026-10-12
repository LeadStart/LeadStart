// An enrichment run's spend by provider (enrichment_runs.cost_breakdown,
// migration 00138). Pure module.
//
// cost_usd stays the run's total. The run-apify-enrichment cron adds every
// charge to the total AND to its provider's share in one write (addCosts), so
// for a run accrued with the breakdown the shares add up to cost_usd. A run from
// before the breakdown reads '{}': its whole cost_usd is "not split". A run that
// was in flight when the breakdown shipped has a not-split part from before it.

export const COST_PROVIDERS = ["apify", "millionverifier", "findymail", "perplexity", "anthropic"] as const;
export type CostProvider = (typeof COST_PROVIDERS)[number];
export type CostBreakdown = Partial<Record<CostProvider, number>>;

export const COST_PROVIDER_LABEL: Record<CostProvider, string> = {
  apify: "Apify",
  millionverifier: "Million Verifier",
  findymail: "Findymail",
  perplexity: "Perplexity",
  anthropic: "Anthropic",
};

// The two columns as a run row carries them (numeric comes back as a string).
export interface RunCostRow {
  cost_usd: number | string | null;
  cost_breakdown?: unknown;
}

export interface RunCost {
  cost_usd: number;
  cost_breakdown: CostBreakdown;
}

// cost_usd is NUMERIC(12,6): keep the shares to the same precision.
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function toUsd(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// Default-safe read: null, a non-object, unknown keys, and values that are not
// a positive number all read as nothing.
export function readCostBreakdown(raw: unknown): CostBreakdown {
  const out: CostBreakdown = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const p of COST_PROVIDERS) {
    const v = toUsd((raw as Record<string, unknown>)[p]);
    if (v > 0) out[p] = v;
  }
  return out;
}

function splitTotal(b: CostBreakdown): number {
  return COST_PROVIDERS.reduce((s, p) => s + (b[p] ?? 0), 0);
}

// The part of cost_usd the breakdown doesn't cover: all of it for a run from
// before the breakdown, 0 for a run accrued with it.
export function unsplitCost(run: RunCostRow): number {
  return Math.max(0, round6(toUsd(run.cost_usd) - splitTotal(readCostBreakdown(run.cost_breakdown))));
}

// Add charges to the total and to each provider's share. Null when there is
// nothing to add (every amount zero, negative or not a number).
export function addCosts(run: RunCostRow, add: CostBreakdown): RunCost | null {
  const breakdown = readCostBreakdown(run.cost_breakdown);
  let total = toUsd(run.cost_usd);
  let added = false;
  for (const p of COST_PROVIDERS) {
    const v = toUsd(add[p]);
    if (v <= 0) continue;
    breakdown[p] = round6((breakdown[p] ?? 0) + v);
    total += v;
    added = true;
  }
  return added ? { cost_usd: round6(total), cost_breakdown: breakdown } : null;
}

// Completion-time Apify reconcile (reconcileRunCost in the cron). Apify posts
// pay-per-event charges after a batch is read, so the Apify share recorded per
// batch can be short; raise it to the sum of the run's Apify runs' FINAL usage.
// Before the breakdown the whole total was floored that way (max(cost_usd, Apify
// final)), which dropped the Million Verifier, Findymail and LLM charges whenever
// it fired; now only the Apify share moves. A run's not-split part (from before
// the breakdown) counts as Apify here, so such a run reconciles exactly as it
// used to. Null when nothing changes.
export function reconcileApifyCost(run: RunCostRow, apifyFinal: number): RunCost | null {
  const breakdown = readCostBreakdown(run.cost_breakdown);
  const gap = round6(apifyFinal - (breakdown.apify ?? 0) - unsplitCost(run));
  if (!(gap > 0)) return null;
  breakdown.apify = round6((breakdown.apify ?? 0) + gap);
  return { cost_usd: round6(toUsd(run.cost_usd) + gap), cost_breakdown: breakdown };
}

// The providers with a share, largest first, for display.
export function costShares(run: RunCostRow): { provider: CostProvider; label: string; usd: number }[] {
  const b = readCostBreakdown(run.cost_breakdown);
  return COST_PROVIDERS.filter((p) => b[p] !== undefined)
    .map((p) => ({ provider: p, label: COST_PROVIDER_LABEL[p], usd: b[p] as number }))
    .sort((x, y) => y.usd - x.usd);
}
