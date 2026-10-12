// pattern_mv: the direct (non-Apify) second-pass email method (migration 00075,
// Phase 2). Generates the common first/last/domain email permutations and
// verifies each through Million Verifier, keeping the first that comes back
// deliverable. Surgical and cheap vs the vdrmota directory dump: MV charges only
// for a determinate answer (catch-all + unknown are free), and the guessing
// stops at the run's paid-guess limit (pattern_max_credits, default 3).
//
// This module is I/O-light on purpose: it only calls the MV client and returns
// per-item outcomes. All DB writes + fail-closed org-state handling live in the
// cron caller (run-apify-enrichment). The candidate generator is pure, lives in
// email-patterns.ts, and is unit-tested by scripts/test-pattern-mv.ts.

import {
  MillionVerifierError,
  type MillionVerifierClient,
  type MillionVerifierResponse,
} from "@/lib/millionverifier/client";
import { generateEmailCandidates } from "./email-patterns";

export { generateEmailCandidates };

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
// domain: the signal the cron uses to route an item to Findymail catch-all
// recovery. Optional: only set where a catch-all was actually seen.
//
// mvResponse is the RAW Million Verifier response for the winning candidate. It
// is a genuine, paid MV verdict, so the cron persists it onto the contact's
// verification cache (via decideFromResult) - that plugs pattern_mv into the
// shared 30-day cache so the end-of-run verify phase and the pre-send gate reuse
// the verdict instead of paying to verify the same address again.
//
// capped marks a miss that stopped at the paid-guess limit (maxCredits) before
// trying every pattern.
export type PatternMvOutcome =
  | { kind: "found"; email: string; confidence: number; mvResult: "ok" | "catch_all"; mvResponse: MillionVerifierResponse; credits: number; candidatesTried: number; sawCatchAll?: boolean }
  | { kind: "not_found"; credits: number; candidatesTried: number; note: string; sawCatchAll?: boolean; capped?: boolean }
  | { kind: "inconclusive"; credits: number; candidatesTried: number; note: string; sawCatchAll?: boolean };

export interface RunPatternMvOpts {
  // Write a catch-all guess (as a risky ~40-confidence hit) when no address
  // verifies clean. Mirrors the org's accept_catch_all_guesses setting.
  acceptCatchAll: boolean;
  // Paid-guess limit: the most MV credits one person may cost per attempt. The
  // guessing stops after this many paid answers (invalid / disposable) without
  // a hit; catch-all and unknown answers are free and don't count. The run's
  // waterfall_config.pattern_max_credits.
  maxCredits: number;
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

// Verify one contact's candidates in order; first `ok` wins, and the guessing
// stops at the paid-guess limit. A DEFINITIVE MV error (bad key / no credits /
// IP blocked) is thrown so the caller can trip the shared fail-closed
// suppression; transient/per-address errors are absorbed as "indeterminate" and
// the item is retried later.
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
  // Hold the winning candidate's email AND its raw MV response: the response is
  // persisted to the contact's verification cache when a catch-all guess is the
  // accepted outcome (same as an `ok` win below).
  let catchAll: { email: string; res: MillionVerifierResponse } | null = null;
  let sawIndeterminate = false;
  let capped = false;

  for (const candidate of candidates) {
    // Every paid answer so far was a miss (an `ok` returns below), so reaching
    // the limit means this person has cost all the credits it may.
    if (credits >= opts.maxCredits) {
      capped = true;
      break;
    }
    if (Date.now() > opts.deadlineMs) {
      return { kind: "inconclusive", credits, candidatesTried: tried, note: "tick deadline reached mid-verify" };
    }
    tried++;
    let res: MillionVerifierResponse;
    try {
      res = await client.verify(candidate, { timeoutSec: opts.timeoutSec });
    } catch (e) {
      if (e instanceof MillionVerifierError && e.definitive) throw e;
      sawIndeterminate = true; // transient (network/5xx/timeout): retry the item later
      continue;
    }
    if (isCharged(res.result)) credits++;
    if (res.result === "ok") {
      return { kind: "found", email: candidate, confidence: 85, mvResult: "ok", mvResponse: res, credits, candidatesTried: tried };
    }
    if (res.result === "catch_all") {
      if (!catchAll) catchAll = { email: candidate, res };
      continue;
    }
    if (res.result === "unknown" || res.result === "error") {
      sawIndeterminate = true;
      continue;
    }
    // invalid / disposable → this candidate is definitively bad; try the next.
  }

  if (catchAll && opts.acceptCatchAll) {
    return { kind: "found", email: catchAll.email, confidence: 40, mvResult: "catch_all", mvResponse: catchAll.res, credits, candidatesTried: tried, sawCatchAll: true };
  }
  // A search stopped at the limit is final even with an unknown answer in it: a
  // retry starts over and pays for the same invalid guesses again, and no
  // pattern_mv find has ever come from a retry (0 of 635, 2026-10-12).
  if (sawIndeterminate && !capped) {
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
    note: catchAll
      ? "only catch-all guesses (not accepted)"
      : capped
        ? `no deliverable address in the first ${tried} patterns (paid-guess limit ${opts.maxCredits})`
        : "no deliverable address in the common patterns",
    sawCatchAll: catchAll !== null,
    ...(capped ? { capped: true } : {}),
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
