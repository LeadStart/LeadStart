// The send-loop verification gate. Given a per-org tick state and a contact,
// decides send / hold / skip and (when a live call is needed) verifies the
// address, persists the result on the contact, and mutates the in-memory
// contact row so a second enrollment sharing it this tick hits the cache.
//
// Called from run-native-sequences as the LAST gate before the Gmail send —
// after window / suppression / DNC / caps / mailbox / render / Gmail-creds have
// all passed — so a credit is only ever spent on an address that would send
// right now. hold/skip never touch the loop's send counters, so a hold leaves
// the mailbox slot free for the next enrollment in the batch.

import type { createAdminClient } from "@/lib/supabase/admin";
import type { Contact } from "@/types/app";
import { MillionVerifierError, MillionVerifierTransientError } from "./client";
import type {
  MillionVerifierClient,
  MillionVerifierErrorKind,
  MillionVerifierResponse,
} from "./client";
import {
  decideFromCached,
  decideFromResult,
  ORG_ERROR_SUPPRESS_MS,
  VERIFY_TIMEOUT_SEC,
  type SendResult,
  type SkipStatus,
} from "./policy";

type AdminClient = ReturnType<typeof createAdminClient>;

// Per-org, per-tick state. `client === null` means the gate is disarmed (no key
// configured) — the contact passes through unverified. suppressedUntilMs is a
// cross-tick 1h window after a definitive account error; tripped is the
// per-tick breaker set the first time an account error is seen this tick.
export interface VerifierTickState {
  organizationId: string;
  client: MillionVerifierClient | null;
  suppressedUntilMs: number | null;
  deadlineMs: number;
  tripped: boolean;
  // Tallies surfaced in the cron's JSON response.
  calls: number;
  cached: number;
  held: number;
  skipped: number;
  counts: Record<string, number>;
  // Credit + error bookkeeping, persisted by finalizeVerifierStates.
  prevCredits: number | null;
  lastCredits: number | null;
  prevErrorStreak: number;
  successThisTick: boolean;
  errorKind: MillionVerifierErrorKind | null;
  errorMessage: string | null;
}

export type GateResult =
  | { action: "send"; result: SendResult | null }
  | { action: "hold"; reason: string }
  | { action: "skip"; status: SkipStatus; reason: string };

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export async function gateContactVerification(args: {
  admin: AdminClient;
  state: VerifierTickState | null;
  contact: Contact;
  now: Date;
}): Promise<GateResult> {
  const { admin, state, contact, now } = args;

  // Disarmed (no per-org state or no key) — pass through, result null.
  if (!state || !state.client) return { action: "send", result: null };
  // Defensive: the loop already guarantees a non-null email before this gate.
  if (!contact.email) return { action: "send", result: null };

  const cached = decideFromCached(contact, now);
  if (cached.action === "send") {
    state.cached++;
    bump(state.counts, cached.result);
    return { action: "send", result: cached.result };
  }
  if (cached.action === "skip") {
    state.cached++;
    state.skipped++;
    bump(state.counts, cached.status);
    return { action: "skip", status: cached.status, reason: cached.reason };
  }
  if (cached.action === "hold") {
    state.held++;
    return { action: "hold", reason: cached.reason };
  }

  // cached.action === "verify" — a live call is required. Respect the breakers
  // before spending a call or the tick budget.
  if (state.tripped || (state.suppressedUntilMs != null && now.getTime() < state.suppressedUntilMs)) {
    state.held++;
    return { action: "hold", reason: "verifier_unavailable" };
  }
  // Wall-clock budget. `now` is the FROZEN tick timestamp the worker passes
  // for cache-freshness math, so comparing it against tickNow + 30s could never
  // trip (SEND_RUNTIME_AUDIT.md SEND-52); the budget must read the live clock.
  if (Date.now() >= state.deadlineMs) {
    state.held++;
    return { action: "hold", reason: "verify_budget" };
  }

  let res: MillionVerifierResponse;
  try {
    res = await state.client.verify(contact.email, { timeoutSec: VERIFY_TIMEOUT_SEC });
  } catch (err) {
    const e =
      err instanceof MillionVerifierError
        ? err
        : new MillionVerifierTransientError(err instanceof Error ? err.message : String(err));
    // Trip the per-tick breaker so we don't hammer a failing account. Definitive
    // errors also open the cross-tick 1h suppression window (persisted via the
    // org row in finalize; set here too so the rest of THIS tick holds fast).
    state.tripped = true;
    state.errorKind = e.kind;
    state.errorMessage = e.message;
    if (e.definitive) state.suppressedUntilMs = now.getTime() + ORG_ERROR_SUPPRESS_MS;
    state.held++;
    return { action: "hold", reason: "verifier_unavailable" };
  }

  state.calls++;
  state.successThisTick = true;
  if (typeof res.credits === "number") state.lastCredits = res.credits;

  const { decision, patch } = decideFromResult(res, contact.email_verification_attempts ?? 0, now);
  const { error } = await admin.from("contacts").update(patch).eq("id", contact.id);
  if (error) {
    console.error(
      `[millionverifier] failed to persist verification for contact ${contact.id}:`,
      error.message ?? error,
    );
  }
  // Mutate the in-memory row so a second enrollment sharing this contact object
  // this tick reads the cache instead of making a second API call.
  Object.assign(contact, patch);
  bump(state.counts, patch.email_verification_status);

  switch (decision.action) {
    case "send":
      return { action: "send", result: decision.result };
    case "skip":
      state.skipped++;
      return { action: "skip", status: decision.status, reason: decision.reason };
    case "hold":
      state.held++;
      return { action: "hold", reason: decision.reason };
    default:
      // decideFromResult never returns "verify"; hold defensively.
      state.held++;
      return { action: "hold", reason: "verifier_unavailable" };
  }
}
