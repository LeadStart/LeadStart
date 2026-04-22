// Singleton Resend wrapper: token-bucket throttle in front of every send,
// typed errors so callers can tell retryable failures from permanent ones.
//
// Throttle: per-process token bucket, 2 req/s default (overridable via
// RESEND_RATE_LIMIT_PER_SEC). Vercel serverless spins up many processes,
// so effective throughput can exceed this — the bucket caps bursts from a
// single function instance, which is the realistic flooding vector for
// our size. When we outgrow that, upgrade to a Supabase-backed bucket.
//
// Error shape: Resend's SDK returns { error: { name, message } } rather than
// raw HTTP status codes. We classify by error.name — known transient names
// become RateLimitedError / TransientResendError (retryable), known 4xx-ish
// names become PermanentResendError (not retryable), and anything unrecognised
// falls into TransientResendError under the principle "retry is safer than
// silent drop when the root cause is ambiguous."

const RATE_LIMIT_PER_SEC_DEFAULT = 2;
const BUCKET_CAPACITY_MULTIPLIER = 1; // capacity = rate * this; keep == rate for smooth pacing

function readRateLimit(): number {
  const raw = process.env.RESEND_RATE_LIMIT_PER_SEC;
  if (!raw) return RATE_LIMIT_PER_SEC_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return RATE_LIMIT_PER_SEC_DEFAULT;
  return parsed;
}

let tokens = readRateLimit() * BUCKET_CAPACITY_MULTIPLIER;
let lastRefillMs = Date.now();

async function consumeToken(): Promise<void> {
  const rate = readRateLimit();
  const capacity = rate * BUCKET_CAPACITY_MULTIPLIER;
  const now = Date.now();
  const elapsedMs = now - lastRefillMs;
  tokens = Math.min(capacity, tokens + (elapsedMs / 1000) * rate);
  lastRefillMs = now;

  if (tokens >= 1) {
    tokens -= 1;
    return;
  }

  const needed = 1 - tokens;
  const waitMs = (needed / rate) * 1000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  // After waiting, refill one token's worth and consume it. We don't re-refill
  // fully because concurrent callers may already be queued behind us.
  tokens = Math.max(0, tokens + (waitMs / 1000) * rate - 1);
  lastRefillMs = Date.now();
}

export class MissingResendKeyError extends Error {
  constructor() {
    super("RESEND_API_KEY is not set. Cannot send email.");
    this.name = "MissingResendKeyError";
  }
}

export class RateLimitedError extends Error {
  constructor(message = "Resend rate-limited") {
    super(message);
    this.name = "RateLimitedError";
  }
}

export class TransientResendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientResendError";
  }
}

export class PermanentResendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentResendError";
  }
}

// Resend SDK error names — inventory from https://resend.com/docs/api-reference/errors.
// Keep this list updated when Resend adds new error types; anything
// unrecognised falls through to TransientResendError.
const PERMANENT_ERROR_NAMES = new Set([
  "validation_error",
  "missing_required_field",
  "invalid_api_key",
  "invalid_from_address",
  "invalid_to_address",
  "invalid_parameter",
  "not_found",
  "forbidden",
  "method_not_allowed",
  "invalid_attachment",
  "invalid_scope",
  "restricted_api_key",
]);

const RATE_LIMITED_ERROR_NAMES = new Set([
  "rate_limit_exceeded",
  "too_many_requests",
]);

function classifyResendError(err: {
  name?: string;
  message?: string;
  statusCode?: number;
}): RateLimitedError | TransientResendError | PermanentResendError {
  const name = err.name ?? "";
  const msg = err.message ?? "(no message)";

  // Prefer statusCode when present (undocumented but sometimes populated).
  if (err.statusCode === 429) return new RateLimitedError(msg);
  if (typeof err.statusCode === "number" && err.statusCode >= 500) {
    return new TransientResendError(`Resend ${err.statusCode}: ${msg}`);
  }

  if (RATE_LIMITED_ERROR_NAMES.has(name)) return new RateLimitedError(msg);
  if (PERMANENT_ERROR_NAMES.has(name)) {
    return new PermanentResendError(`Resend ${name}: ${msg}`);
  }
  // Unknown → default to transient. Losing a send to the retry queue is
  // recoverable; losing it to a silent drop is not.
  return new TransientResendError(`Resend ${name || "unknown"}: ${msg}`);
}

type ResendSdk = typeof import("resend");
let cachedResendInstance: InstanceType<ResendSdk["Resend"]> | null = null;

async function getResend(): Promise<InstanceType<ResendSdk["Resend"]>> {
  if (!process.env.RESEND_API_KEY) throw new MissingResendKeyError();
  if (!cachedResendInstance) {
    const { Resend } = await import("resend");
    cachedResendInstance = new Resend(process.env.RESEND_API_KEY);
  }
  return cachedResendInstance;
}

export interface ResendSendParams {
  from: string;
  to: string | string[];
  cc?: string[];
  subject: string;
  html: string;
}

export interface ResendSendResult {
  id: string | null;
}

/**
 * Send a transactional email via Resend, with throttle + typed-error handling.
 *
 * Throws: MissingResendKeyError | RateLimitedError | TransientResendError |
 * PermanentResendError. Callers should treat the first three as retryable
 * (queue the row for the retry cron) and PermanentResendError as terminal
 * (mark the row failed with max retry_count so the cron skips it).
 */
export async function sendViaResend(
  params: ResendSendParams,
): Promise<ResendSendResult> {
  await consumeToken();
  const resend = await getResend();
  const { data, error } = await resend.emails.send(params);
  if (error) {
    throw classifyResendError(error as { name?: string; message?: string });
  }
  return { id: data?.id ?? null };
}
