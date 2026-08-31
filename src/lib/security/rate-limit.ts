// Shared, cross-instance rate limiting for public / auth endpoints.
//
// Vercel serverless functions don't share memory, so an in-memory Map (like the
// one on /api/site-chat) only throttles a single warm instance. This helper is
// backed by the rate_limits table + consume_rate_limit() RPC (migration 00105),
// which every instance shares and increments atomically.
//
// FAILS OPEN: if the store is unreachable — or the migration isn't applied yet —
// the request is allowed and the error logged. These guards exist to blunt abuse,
// not to lock legit users out on an infra hiccup, so anything security-critical
// must ALSO rest on a structural guard (a token, the origin allowlist, an owner
// gate). Failing open also means routes can adopt this now and degrade to
// "no limit" until 00105 lands in prod.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window (0 once over). */
  remaining: number;
  /** Seconds until the window resets (0 while under the limit). */
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  /** Stable prefix identifying the endpoint + dimension, e.g. "contact:ip". */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Best-effort client IP from proxy headers. Vercel populates x-forwarded-for.
 * Spoofable, so pair an IP bucket with an identity bucket (email / user id) for
 * anything that matters. Mirrors the derivation in /api/site-chat.
 */
export function clientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Increment + check one bucket. See file header for the fail-open contract. */
export async function checkRateLimit(rule: RateLimitRule): Promise<RateLimitResult> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("consume_rate_limit", {
      p_bucket: rule.bucket,
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
    });
    if (error || !data) {
      console.warn("[rate-limit] store error, failing open:", error?.message ?? "no data");
      return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
    }
    const d = data as { allowed: boolean; remaining: number; retry_after_seconds: number };
    return {
      allowed: d.allowed !== false,
      remaining: d.remaining ?? 0,
      retryAfterSeconds: d.retry_after_seconds ?? 0,
    };
  } catch (err) {
    console.warn("[rate-limit] unexpected error, failing open:", err);
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
  }
}

/**
 * Check several buckets and return the first that trips (so a route can enforce
 * both an IP limit and a per-email limit in one call). Every bucket is consumed
 * (they all count the attempt); the returned result is the tripped one, or the
 * last allowed one. Buckets are consumed in order.
 */
export async function checkRateLimits(rules: RateLimitRule[]): Promise<RateLimitResult> {
  let last: RateLimitResult = { allowed: true, remaining: 0, retryAfterSeconds: 0 };
  let tripped: RateLimitResult | null = null;
  for (const rule of rules) {
    const res = await checkRateLimit(rule);
    last = res;
    if (!res.allowed && !tripped) tripped = res;
  }
  return tripped ?? last;
}

/** Standard 429 with a Retry-After header. */
export function tooManyRequests(retryAfterSeconds: number, message?: string): NextResponse {
  const retry = Math.max(1, Math.ceil(retryAfterSeconds || 1));
  return NextResponse.json(
    { error: message ?? "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(retry) } },
  );
}
