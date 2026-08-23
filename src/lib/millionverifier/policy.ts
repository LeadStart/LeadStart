// Pure decision logic for the just-in-time verification gate. No I/O, no DB, no
// network — everything here is a function of a cached contact row, a raw API
// response, and the current time, so it is exhaustively unit-testable
// (scripts/test-millionverifier-policy.ts).
//
// Owner-confirmed policy:
//   ok         -> send
//   catch_all  -> send, flagged risky (can't confirm/deny; bounce monitoring +
//                 inbox-health auto-pause catch any damage)
//   unknown    -> hold + retry (free) up to MAX_UNKNOWN_ATTEMPTS, then send
//                 flagged risky
//   invalid    -> skip terminally (enrollment failed, contact flagged)
//   disposable -> skip terminally
//   error      -> hold + retry up to MAX_ERROR_ATTEMPTS, then skip terminally
//   free/role  -> stored as flags only; never affects the send decision
// Fresh cached results (<= 30 days) reuse the verdict with no API call, so
// follow-up steps to an already-verified contact are free.

import type {
  Contact,
  EmailVerificationQuality,
  EmailVerificationStatus,
} from "@/types/app";
import type { MillionVerifierErrorKind, MillionVerifierResponse } from "./client";

const DAY_MS = 86_400_000;

export const VERIFICATION_TTL_DAYS = 30;
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

export type PolicyDecision =
  | { action: "send"; result: SendResult; risky: boolean }
  | { action: "skip"; status: SkipStatus; reason: string }
  | { action: "hold"; reason: string }
  | { action: "verify" };

// The only contact fields the cache decision reads — tests pass minimal objects.
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

// A result we don't recognize is coerced to "error" (indeterminate, retried) —
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

export function isFresh(verifiedAt: string | null, now: Date): boolean {
  if (!verifiedAt) return false;
  const ts = Date.parse(verifiedAt);
  if (Number.isNaN(ts)) return false;
  return now.getTime() - ts <= VERIFICATION_TTL_DAYS * DAY_MS;
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
export function decideFromCached(contact: CacheView, now: Date): PolicyDecision {
  const status = contact.email_verification_status;
  const verifiedAt = contact.email_verified_at;
  const attempts = contact.email_verification_attempts ?? 0;

  if (!status || !isFresh(verifiedAt, now)) return { action: "verify" };

  switch (status) {
    case "ok":
      return { action: "send", result: "ok", risky: false };
    case "catch_all":
      return { action: "send", result: "catch_all", risky: true };
    case "invalid":
      return { action: "skip", status: "invalid", reason: "address is invalid" };
    case "disposable":
      return { action: "skip", status: "disposable", reason: "address is a disposable domain" };
    case "unknown":
      if (attempts >= MAX_UNKNOWN_ATTEMPTS) {
        return { action: "send", result: "unknown", risky: true };
      }
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
      decision = { action: "send", result: "catch_all", risky: true };
      break;
    case "invalid":
      decision = { action: "skip", status: "invalid", reason: "address is invalid" };
      break;
    case "disposable":
      decision = { action: "skip", status: "disposable", reason: "address is a disposable domain" };
      break;
    case "unknown":
      decision =
        attempts >= MAX_UNKNOWN_ATTEMPTS
          ? { action: "send", result: "unknown", risky: true }
          : { action: "hold", reason: "unknown_backoff" };
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
