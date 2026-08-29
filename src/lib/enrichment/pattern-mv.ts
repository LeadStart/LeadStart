// pattern_mv — the direct (non-Apify) second-pass email method (migration 00075,
// Phase 2). Generates the common first/last/domain email permutations and
// verifies each through Million Verifier, keeping the first that comes back
// deliverable. Surgical and cheap (~≤6 MV credits/contact, catch-all + unknown
// are free) vs the vdrmota directory dump.
//
// This module is I/O-light on purpose: it only calls the MV client and returns
// per-item outcomes. All DB writes + fail-closed org-state handling live in the
// cron caller (run-apify-enrichment). The candidate generator is pure and
// unit-tested by scripts/test-pattern-mv.ts.

import {
  MillionVerifierError,
  type MillionVerifierClient,
  type MillionVerifierResponse,
} from "@/lib/millionverifier/client";

// Strip a name part down to an email-local-part-safe token: drop diacritics,
// lowercase, keep [a-z0-9] only ("José" → "jose", "O'Brien" → "obrien").
function normalizePart(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeDomain(domain: string | null | undefined): string {
  return (domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

// The common decision-maker email permutations, in descending likelihood:
//   first.last@ → first@ → flast@ → f.last@ → last@ → firstlast@
// Deduped, order preserved. Empty when there's no domain or no usable name.
export function generateEmailCandidates(
  first: string | null | undefined,
  last: string | null | undefined,
  domain: string | null | undefined,
): string[] {
  const f = normalizePart(first);
  const l = normalizePart(last);
  const d = normalizeDomain(domain);
  if (!d || (!f && !l)) return [];

  const locals: string[] = [];
  if (f && l) locals.push(`${f}.${l}`);
  if (f) locals.push(f);
  if (f && l) locals.push(`${f[0]}${l}`);
  if (f && l) locals.push(`${f[0]}.${l}`);
  if (l) locals.push(l);
  if (f && l) locals.push(`${f}${l}`);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const local of locals) {
    if (!local || seen.has(local)) continue;
    seen.add(local);
    out.push(`${local}@${d}`);
  }
  return out;
}

// MV charges a credit only for a determinate verdict (ok/invalid/disposable);
// catch_all, unknown, and per-address errors are free.
function isCharged(result: string): boolean {
  return result === "ok" || result === "invalid" || result === "disposable";
}

export interface PatternMvItem {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company_domain: string | null;
}

// sawCatchAll marks that at least one candidate came back catch_all on this
// domain — the signal the cron uses to route an item to Findymail catch-all
// recovery. Optional: only set where a catch-all was actually seen.
export type PatternMvOutcome =
  | { kind: "found"; email: string; confidence: number; mvResult: "ok" | "catch_all"; credits: number; candidatesTried: number; sawCatchAll?: boolean }
  | { kind: "not_found"; credits: number; candidatesTried: number; note: string; sawCatchAll?: boolean }
  | { kind: "inconclusive"; credits: number; candidatesTried: number; note: string; sawCatchAll?: boolean };

export interface RunPatternMvOpts {
  // Write a catch-all guess (as a risky ~40-confidence hit) when no address
  // verifies clean. Mirrors the org's accept_catch_all_guesses setting.
  acceptCatchAll: boolean;
  // Per-address MV server-side timeout (seconds). A slow mail server returns
  // "unknown" at this bound rather than hanging.
  timeoutSec: number;
  // Absolute wall-clock budget (ms since epoch). Workers stop picking up new
  // items past it; unprocessed items are simply absent from the result map
  // (the caller leaves them pending for the next tick).
  deadlineMs: number;
  // Parallel MV calls. MV real-time verify is typically 1–3s, so a small pool
  // keeps a batch inside the cron tick.
  concurrency: number;
}

// Verify one contact's candidates in order; first `ok` wins. A DEFINITIVE MV
// error (bad key / no credits / IP blocked) is thrown so the caller can trip
// the shared fail-closed suppression; transient/per-address errors are absorbed
// as "indeterminate" and the item is retried later.
async function processItem(
  client: MillionVerifierClient,
  item: PatternMvItem,
  opts: RunPatternMvOpts,
): Promise<PatternMvOutcome> {
  const candidates = generateEmailCandidates(item.first_name, item.last_name, item.company_domain);
  if (candidates.length === 0) {
    return { kind: "not_found", credits: 0, candidatesTried: 0, note: "insufficient first/last/domain for a pattern" };
  }

  let credits = 0;
  let tried = 0;
  let catchAll: string | null = null;
  let sawIndeterminate = false;

  for (const candidate of candidates) {
    if (Date.now() > opts.deadlineMs) {
      return { kind: "inconclusive", credits, candidatesTried: tried, note: "tick deadline reached mid-verify" };
    }
    tried++;
    let res: MillionVerifierResponse;
    try {
      res = await client.verify(candidate, { timeoutSec: opts.timeoutSec });
    } catch (e) {
      if (e instanceof MillionVerifierError && e.definitive) throw e;
      sawIndeterminate = true; // transient (network/5xx/timeout) — retry the item later
      continue;
    }
    if (isCharged(res.result)) credits++;
    if (res.result === "ok") {
      return { kind: "found", email: candidate, confidence: 85, mvResult: "ok", credits, candidatesTried: tried };
    }
    if (res.result === "catch_all") {
      if (!catchAll) catchAll = candidate;
      continue;
    }
    if (res.result === "unknown" || res.result === "error") {
      sawIndeterminate = true;
      continue;
    }
    // invalid / disposable → this candidate is definitively bad; try the next.
  }

  if (catchAll && opts.acceptCatchAll) {
    return { kind: "found", email: catchAll, confidence: 40, mvResult: "catch_all", credits, candidatesTried: tried, sawCatchAll: true };
  }
  if (sawIndeterminate) {
    return {
      kind: "inconclusive",
      credits,
      candidatesTried: tried,
      note: catchAll ? "catch-all only (not accepted) + indeterminate candidates" : "all candidates indeterminate",
      sawCatchAll: catchAll !== null,
    };
  }
  return {
    kind: "not_found",
    credits,
    candidatesTried: tried,
    note: catchAll ? "only catch-all guesses (not accepted)" : "no deliverable address in the common patterns",
    sawCatchAll: catchAll !== null,
  };
}

// Verify a batch with a bounded worker pool. Returns a per-item outcome map for
// everything processed before the deadline. Rejects with the MV error on the
// first definitive account failure (the caller discards partial results and
// holds the batch).
export async function runPatternMv(
  client: MillionVerifierClient,
  items: PatternMvItem[],
  opts: RunPatternMvOpts,
): Promise<Map<string, PatternMvOutcome>> {
  const results = new Map<string, PatternMvOutcome>();
  const conc = Math.max(1, Math.min(opts.concurrency, items.length || 1));
  let idx = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() > opts.deadlineMs) return;
      const i = idx++;
      if (i >= items.length) return;
      const item = items[i];
      const outcome = await processItem(client, item, opts);
      results.set(item.id, outcome);
    }
  }

  await Promise.all(Array.from({ length: conc }, () => worker()));
  return results;
}
