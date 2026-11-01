// Pure decision logic for the just-in-time verification gate. No I/O, no DB, no
// network: everything here is a function of a cached contact row, a raw API
// response, and the current time, so it is exhaustively unit-testable
// (scripts/test-millionverifier-policy.ts).
//
// Policy (owner picks 2026-11-01, after PolishPoint's first emails bounced on
// catch-alls 4 of 7; cardinal rule "only proven addresses get a first email" in
// CLAUDE.md):
//   ok         -> send
//   catch_all  -> FIRST email: park (held out of line) unless the campaign opts
//                 in (campaigns.send_unproven_addresses), then send flagged risky.
//                 Follow-up: send flagged risky (the address took email 1).
//   unknown    -> hold + retry (free) up to MAX_UNKNOWN_ATTEMPTS, then the same
//                 as catch_all: park a first email unless opted in
//   invalid    -> skip terminally (enrollment failed, contact flagged)
//   disposable -> skip terminally
//   error      -> hold + retry up to MAX_ERROR_ATTEMPTS, then skip terminally
//   free/role  -> stored as flags only; never affects the send decision
// A first email needs a result from the last FIRST_EMAIL_TTL_DAYS (7); older is
// checked again live. Follow-ups reuse anything from the last 30 days for free.
// The old "catch_all -> send; bounce monitoring + inbox-health auto-pause catch
// any damage" was wrong: inbox health scores bounces only from 20 sends a week
// per inbox, so in a campaign's first week nothing watched.

import type {
  Contact,
  EmailVerificationQuality,
  EmailVerificationStatus,
} from "@/types/app";
import type { MillionVerifierErrorKind, MillionVerifierResponse } from "./client";

const DAY_MS = 86_400_000;

export const VERIFICATION_TTL_DAYS = 30;
// A first email to an address needs a check this recent (owner pick 2026-11-01).
export const FIRST_EMAIL_TTL_DAYS = 7;
export const RETRY_BACKOFF_MS = 60 * 60 * 1000; // 1h between retries of an indeterminate address
export const MAX_UNKNOWN_ATTEMPTS = 3;
export const MAX_ERROR_ATTEMPTS = 5;
export const CREDITS_LOW_THRESHOLD = 500;
export const VERIFY_TIMEOUT_SEC = 8; // server-side timeout param; slow servers -> "unknown"
export const VERIFY_DEADLINE_MS = 30_000; // per-tick wall-clock budget for API calls
export const ORG_ERROR_SUPPRESS_MS = 60 * 60 * 1000; // stop calling for 1h after a definitive error
export const TRANSIENT_ALERT_STREAK = 3; // consecutive failing ticks before a transient alert

export type SendResult = "ok" | "catch_all" | "unknown";
export type SkipStatus = "invalid" | "disposable" | "error";

/** How the gate treats one send. */
export interface GateRules {
  /** A cached result older than this many days is checked again live. */
  ttlDays: number;
  /** Park a catch-all / unknown address (out of line) instead of sending it. */
  holdUnproven: boolean;
}

/** Follow-ups (and non-send callers): 30-day cache, catch-alls send flagged risky. */
export const FOLLOW_UP_RULES: GateRules = { ttlDays: VERIFICATION_TTL_DAYS, holdUnproven: false };

/** The rules for the email at stepIndex (0 = the first email to this contact). */
export function gateRulesFor(stepIndex: number, sendUnproven: boolean): GateRules {
  return stepIndex === 0
    ? { ttlDays: FIRST_EMAIL_TTL_DAYS, holdUnproven: !sendUnproven }
    : FOLLOW_UP_RULES;
}

export type UnprovenResult = "catch_all" | "unknown";

/** The enrollment's last_error while it is parked; the release matches this prefix. */
export const UNPROVEN_HOLD_PREFIX = "Held: unproven address";

export function unprovenHoldReason(result: UnprovenResult): string {
  return `${UNPROVEN_HOLD_PREFIX} (${result === "catch_all" ? "catch-all" : "unknown"}). This campaign doesn't send to catch-all or unknown addresses.`;
}

export type PolicyDecision =
  | { action: "send"; result: SendResult; risky: boolean }
  | { action: "park"; result: UnprovenResult }
  | { action: "skip"; status: SkipStatus; reason: string }
  | { action: "hold"; reason: string }
  | { action: "verify" };

// The only contact fields the cache decision reads: tests pass minimal objects.
export type CacheView = Pick<
  Contact,
  "email_verification_status" | "email_verified_at" | "email_verification_attempts"
>;

export interface ContactVerificationPatch {
  email_verification_status: EmailVerificationStatus;
  email_verification_subresult: string | null;
  email_verification_quality: EmailVerificationQuality | null;
  email_is_free: boolean;
  email_is_role: boolean;
  email_did_you_mean: string | null;
  email_verified_at: string;
  email_verification_attempts: number;
}

const STATUS_VALUES: readonly EmailVerificationStatus[] = [
  "ok",
  "catch_all",
  "unknown",
  "invalid",
  "disposable",
  "error",
];
const QUALITY_VALUES: readonly EmailVerificationQuality[] = ["good", "bad", "risky"];

// A result we don't recognize is coerced to "error" (indeterminate, retried),
// never silently treated as "ok".
export function normalizeStatus(result: string): EmailVerificationStatus {
  return (STATUS_VALUES as readonly string[]).includes(result)
    ? (result as EmailVerificationStatus)
    : "error";
}

function normalizeQuality(quality: string): EmailVerificationQuality | null {
  return (QUALITY_VALUES as readonly string[]).includes(quality)
    ? (quality as EmailVerificationQuality)
    : null;
}

export function isFresh(verifiedAt: string | null, now: Date, ttlDays: number = VERIFICATION_TTL_DAYS): boolean {
  if (!verifiedAt) return false;
  const ts = Date.parse(verifiedAt);
  if (Number.isNaN(ts)) return false;
  return now.getTime() - ts <= ttlDays * DAY_MS;
}

// catch_all, or unknown out of retries: send flagged risky, or park.
function unproven(result: UnprovenResult, rules: GateRules): PolicyDecision {
  return rules.holdUnproven ? { action: "park", result } : { action: "send", result, risky: true };
}

/** With the gate off (no key, or the campaign opted out of checks), a cached
 *  catch-all / unknown verdict still parks a first email: no API call is made. */
export function parkFromCachedStatus(
  status: EmailVerificationStatus | null | undefined,
  rules: GateRules,
): PolicyDecision | null {
  if (!rules.holdUnproven) return null;
  return status === "catch_all" || status === "unknown" ? { action: "park", result: status } : null;
}

function withinBackoff(verifiedAt: string | null, now: Date): boolean {
  if (!verifiedAt) return false;
  const ts = Date.parse(verifiedAt);
  if (Number.isNaN(ts)) return false;
  return now.getTime() - ts < RETRY_BACKOFF_MS;
}

// Decide from the cached contact row alone. Returns { action: "verify" } when a
// live API call is required (no fresh cache, or an indeterminate result whose
// backoff has elapsed). Everything else short-circuits with no API call.
export function decideFromCached(
  contact: CacheView,
  now: Date,
  rules: GateRules = FOLLOW_UP_RULES,
): PolicyDecision {
  const status = contact.email_verification_status;
  const verifiedAt = contact.email_verified_at;
  const attempts = contact.email_verification_attempts ?? 0;

  if (!status || !isFresh(verifiedAt, now, rules.ttlDays)) return { action: "verify" };

  switch (status) {
    case "ok":
      return { action: "send", result: "ok", risky: false };
    case "catch_all":
      return unproven("catch_all", rules);
    case "invalid":
      return { action: "skip", status: "invalid", reason: "address is invalid" };
    case "disposable":
      return { action: "skip", status: "disposable", reason: "address is a disposable domain" };
    case "unknown":
      if (attempts >= MAX_UNKNOWN_ATTEMPTS) return unproven("unknown", rules);
      return withinBackoff(verifiedAt, now)
        ? { action: "hold", reason: "unknown_backoff" }
        : { action: "verify" };
    case "error":
      if (attempts >= MAX_ERROR_ATTEMPTS) {
        return { action: "skip", status: "error", reason: "verification repeatedly errored" };
      }
      return withinBackoff(verifiedAt, now)
        ? { action: "hold", reason: "error_backoff" }
        : { action: "verify" };
    default:
      return { action: "verify" };
  }
}

// Decide from a fresh API response, and build the DB patch to persist. attempts
// increments only for indeterminate results (unknown / error) and resets to 0
// on any definitive verdict.
export function decideFromResult(
  res: MillionVerifierResponse,
  attemptsBefore: number,
  now: Date,
  rules: GateRules = FOLLOW_UP_RULES,
): { decision: PolicyDecision; patch: ContactVerificationPatch } {
  const status = normalizeStatus(res.result);
  const indeterminate = status === "unknown" || status === "error";
  const attempts = indeterminate ? (attemptsBefore ?? 0) + 1 : 0;

  const patch: ContactVerificationPatch = {
    email_verification_status: status,
    email_verification_subresult: res.subresult || null,
    email_verification_quality: normalizeQuality(res.quality),
    email_is_free: !!res.free,
    email_is_role: !!res.role,
    email_did_you_mean: res.didyoumean || null,
    email_verified_at: now.toISOString(),
    email_verification_attempts: attempts,
  };

  let decision: PolicyDecision;
  switch (status) {
    case "ok":
      decision = { action: "send", result: "ok", risky: false };
      break;
    case "catch_all":
      decision = unproven("catch_all", rules);
      break;
    case "invalid":
      decision = { action: "skip", status: "invalid", reason: "address is invalid" };
      break;
    case "disposable":
      decision = { action: "skip", status: "disposable", reason: "address is a disposable domain" };
      break;
    case "unknown":
      decision =
        attempts >= MAX_UNKNOWN_ATTEMPTS ? unproven("unknown", rules) : { action: "hold", reason: "unknown_backoff" };
      break;
    case "error":
    default:
      decision =
        attempts >= MAX_ERROR_ATTEMPTS
          ? { action: "skip", status: "error", reason: "verification repeatedly errored" }
          : { action: "hold", reason: "error_backoff" };
      break;
  }
  return { decision, patch };
}

// Edge-trigger: alert only when the balance crosses below the threshold, so a
// lingering-low balance alerts once (not every tick). prev == null (first
// observation) counts as a crossing.
export function shouldAlertLowCredits(prev: number | null, next: number): boolean {
  return next < CREDITS_LOW_THRESHOLD && (prev == null || prev >= CREDITS_LOW_THRESHOLD);
}

// Definitive account errors (auth/credits/blocked) alert on the first failure
// (streak 1) and stay silent while suppressed. Transient errors alert only
// after a run of consecutive failing ticks, then stay silent until a success
// resets the streak.
export function shouldAlertAccountError(kind: MillionVerifierErrorKind, streak: number): boolean {
  return kind === "transient" ? streak === TRANSIENT_ALERT_STREAK : streak === 1;
}
