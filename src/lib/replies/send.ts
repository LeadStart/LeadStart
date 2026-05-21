// Helpers for /api/replies/[id]/send.
//
// At present this just exposes computeIdempotencyKey — the Salesforge
// request-shaping logic lives inline in the route itself.

import crypto from "node:crypto";

/**
 * Deterministic idempotency key derivation: sha256(reply.id + body_text)
 * truncated to the first 16 hex chars. Stored on lead_replies.idempotency_key
 * so a future commit can add an active pre-check that closes the
 * timeout-rollback-retry window. The atomic status claim on
 * /api/replies/[id]/send is the primary dedup today.
 */
export function computeIdempotencyKey(replyId: string, bodyText: string): string {
  return crypto
    .createHash("sha256")
    .update(`${replyId}${bodyText}`)
    .digest("hex")
    .slice(0, 16);
}
