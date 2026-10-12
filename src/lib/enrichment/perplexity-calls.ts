// The Perplexity calls an enrichment run made, counted from its items' notes.
// Pure module.
//
// Until 2026-10-12 a run's cost_usd held Perplexity's tokens but not its
// per-request fee. The tube-pipeline report (enrich-report.mts) and the fee
// backfill (scripts/backfill-perplexity-fee.ts) count a run's calls here and add
// the fee for runs recorded without it.

import { normalizeCompanyName } from "../apify/domain";
import { PERPLEXITY_MODEL, PERPLEXITY_REQUEST_FEE_USD } from "../decision-maker/pricing";
import { DISCOVERY_BATCH } from "./domain-discovery";
import { readCostBreakdown, type RunCostRow } from "./run-cost";

// The fee per call on the model both callers used.
export const PERPLEXITY_FEE_USD = PERPLEXITY_REQUEST_FEE_USD[PERPLEXITY_MODEL];

// Owner naming's web lookup (Layer 2) ran on Perplexity Sonar from 2026-08-28
// until 2026-10-11 (de633d2). Every lookup Perplexity answered ended the item's
// notes with this; an error or a missing key left other notes.
export function isPerplexityNamingNote(note: string | null | undefined): boolean {
  return (note ?? "").includes("Perplexity sonar completed");
}

export function countNamingCalls(items: { naming_notes: string | null }[]): number {
  return items.filter((i) => isPerplexityNamingNote(i.naming_notes)).length;
}

// Calls behind an item's website-lookup note (runDomainDiscovery's outcomes):
// one for a call Perplexity answered (found, "found no website", rejected), N
// for "inconclusive after N attempts" on unparseable answers (each one was
// answered), none for an error, a missing key, or another step's note.
export function lookupCallsInNote(note: string | null | undefined): number {
  const n = note ?? "";
  if (/^(discovered via sonar|web lookup found no website|rejected: )/.test(n)) return 1;
  const retried = /^inconclusive after (\d+) attempts: web lookup returned unparseable output/.exec(n);
  return retried ? Number(retried[1]) : 0;
}

export interface LookupItemRow {
  id: string;
  created_at: string;
  company_id: string | null;
  company_slug: string | null;
  company_name: string | null;
  domain_status: string | null;
  domain_notes: string | null;
}

// The items runDomainDiscoveryBatch claimed: name-only (no LinkedIn company ref)
// and pending in the domains phase. An item born 'skipped' (it already had a
// domain, or discovery was off) never was; dropAlreadyDone's skip was.
function wasClaimed(i: LookupItemRow): boolean {
  if (i.company_id != null || i.company_slug != null || !i.company_name) return false;
  return i.domain_status !== "skipped" || i.domain_notes === "target already set on contact";
}

// Website-lookup calls in one run. Items of one firm (same name + location) in
// one claimed batch shared a single call (runDomainDiscovery gives each the same
// answer), so they count once. The batches are replayed as consecutive runs of
// DISCOVERY_BATCH claimed items in claim order (created_at, id). A tick that hit
// its deadline left items for the next one, which shifts later batches in a way
// the notes can't show.
export function countLookupCalls<T extends LookupItemRow>(
  items: T[],
  locationOf: (item: T) => string | null,
): { items: number; calls: number } {
  const queue = items
    .filter(wasClaimed)
    .sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  let billedItems = 0;
  let calls = 0;
  for (let start = 0; start < queue.length; start += DISCOVERY_BATCH) {
    const firms = new Set<string>();
    for (const item of queue.slice(start, start + DISCOVERY_BATCH)) {
      const n = lookupCallsInNote(item.domain_notes);
      if (n === 0) continue;
      billedItems++;
      const firm = `${normalizeCompanyName(item.company_name)}|${(locationOf(item) ?? "").toLowerCase().trim()}`;
      if (firms.has(firm)) continue;
      firms.add(firm);
      calls += n;
    }
  }
  return { items: billedItems, calls };
}

// Whether a run's cost_usd already holds the fee for its Perplexity calls: it
// has a Perplexity share, written by the cron with each call's fee (from
// 2026-10-12) or by the backfill. A run without one was recorded tokens only.
// A run in flight when the fee started being recorded holds both kinds of call,
// which this can't tell apart.
export function perplexityFeeRecorded(run: RunCostRow): boolean {
  return readCostBreakdown(run.cost_breakdown).perplexity !== undefined;
}
