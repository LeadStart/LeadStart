// HMAC-signed, single-use portal deep-links for the hot-lead notification email.
//
// Why a signed URL and not a session token?
//   The email is sent to clients.notification_email — which may or may not
//   be the address they log in with (e.g. personal Gmail vs. @company.com).
//   The link has to work cold: tap on mobile, land in the dossier, no login.
//   A short-lived HMAC token is the minimum machinery that proves the URL
//   came from us.
//
// Why single-use?
//   Email forwarding, screenshot sharing, URL scanners — any of these can
//   replay the link. The consumed-at check turns the token into a
//   one-shot: first click wins, everything after is rejected.
//
// Token shape: <base64url(payload)>.<base64url(hmac)>
//   payload = { r: replyId, e: expiresAtMs }
//   hmac    = HMAC-SHA256(payload, URL_SIGNING_SECRET)
//
// Stored hash: SHA-256 of the whole token string. One-way; lookup key only.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";

const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export class MissingSigningSecretError extends Error {
  constructor() {
    super("URL_SIGNING_SECRET is not set. Generate with `openssl rand -hex 32`.");
    this.name = "MissingSigningSecretError";
  }
}

function requireSecret(): string {
  const s = process.env.URL_SIGNING_SECRET;
  if (!s || s.length < 32) throw new MissingSigningSecretError();
  return s;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 2 ? "==" : str.length % 4 === 3 ? "=" : "";
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

interface TokenPayload {
  r: string; // replyId
  e: number; // expiresAtMs
}

function hmacOver(payloadB64: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadB64).digest();
}

/**
 * SHA-256 of the token string. Stored in `lead_replies.notification_token_hash`
 * so verifyReplyUrl can look up the row without the token itself ever hitting
 * the DB. Exposed for callers that want to compute the hash directly.
 */
export function hashReplyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SignedReplyUrl {
  /** Goes in the email URL as ?token=... */
  token: string;
  /** Store this on `lead_replies.notification_token_hash` at send time. */
  hash: string;
  /** Epoch ms when this token expires. */
  expiresAt: number;
}

/**
 * Mint a fresh signed token for a reply.
 *
 * Intentionally returns both `token` and `hash` — the two are always used
 * together (token goes in the URL, hash goes in the DB at the same time),
 * so handing the caller both removes a whole class of "forgot to store the
 * hash" bugs.
 */
export function signReplyUrl(replyId: string): SignedReplyUrl {
  const secret = requireSecret();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload: TokenPayload = { r: replyId, e: expiresAt };
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload)));
  const mac = hmacOver(payloadB64, secret);
  const token = `${payloadB64}.${base64urlEncode(mac)}`;
  return { token, hash: hashReplyToken(token), expiresAt };
}

export interface ParsedToken {
  replyId: string;
  expiresAt: number;
}

/**
 * Parse + HMAC-verify + expiry-check only. No DB access, no consumption.
 * Returns null on any failure. Exposed so tests can exercise the pure
 * crypto half of the contract without stubbing a Supabase client.
 */
export function parseAndVerifyToken(token: string, now = Date.now()): ParsedToken | null {
  let secret: string;
  try {
    secret = requireSecret();
  } catch {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, macB64] = parts;

  // HMAC compare: recompute over the payload, timing-safe compare.
  let given: Buffer;
  try {
    given = base64urlDecode(macB64);
  } catch {
    return null;
  }
  const expected = hmacOver(payloadB64, secret);
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;

  // Parse payload. If the HMAC matched, this was the payload we signed,
  // but we still catch malformed JSON defensively.
  let payload: TokenPayload;
  try {
    const json = base64urlDecode(payloadB64).toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof payload?.r !== "string" || typeof payload?.e !== "number") return null;
  if (payload.e <= now) return null;

  return { replyId: payload.r, expiresAt: payload.e };
}

/**
 * Full verify: HMAC + expiry + single-use consumption.
 *
 * On the first successful call for a given token, the row's
 * notification_token_consumed_at is stamped atomically. Subsequent calls —
 * including concurrent ones that won the race to our SELECT — are rejected
 * by the `IS NULL` predicate on the UPDATE and return null.
 *
 * Call from an unauthenticated route (the email link) passing the admin
 * client — this bypass is intentional; the HMAC + single-use IS the auth.
 */
export async function verifyReplyUrl(
  token: string,
  admin: ReturnType<typeof createAdminClient>
): Promise<{ replyId: string } | null> {
  const parsed = parseAndVerifyToken(token);
  if (!parsed) return null;

  const hash = hashReplyToken(token);

  // Single-trip atomic consume: only updates rows that (a) match this
  // specific hash and (b) haven't been consumed yet. Zero rows returned
  // means either the hash doesn't match any reply, or somebody else already
  // consumed this token. Either way: reject.
  const { data, error } = await admin
    .from("lead_replies")
    .update({ notification_token_consumed_at: new Date().toISOString() })
    .eq("notification_token_hash", hash)
    .is("notification_token_consumed_at", null)
    .select("id")
    .maybeSingle();

  if (error || !data) return null;

  const row = data as { id: string };
  // Belt-and-suspenders: the token binds a specific replyId; if that
  // doesn't match the row we just updated (which would require a hash
  // collision on SHA-256 OR the token being minted for a different row),
  // refuse.
  if (row.id !== parsed.replyId) return null;

  return { replyId: parsed.replyId };
}
