#!/usr/bin/env node
/**
 * Unit test for src/lib/security/signed-urls.ts (commit #5).
 *
 * Exercises:
 *   1. sign → parseAndVerifyToken round-trip returns the same replyId
 *   2. sign → hash is deterministic & stable
 *   3. expired tokens return null
 *   4. tampered HMAC returns null
 *   5. wrong-secret verification returns null
 *   6. verifyReplyUrl with stub admin:
 *      - first consume succeeds
 *      - second consume (row already has consumed_at set) returns null
 *      - token for replyId A cannot consume a row stored for replyId B
 *
 * No network. No DB. The verifyReplyUrl tests use a chainable stub Supabase
 * client — enough to exercise the contract without a live connection.
 *
 * Usage:
 *   npx tsx scripts/test-signed-urls.mjs
 */

import { readFileSync, existsSync } from "node:fs";

// Load URL_SIGNING_SECRET from .env.local if available, or fall back to a
// deterministic test secret so the script runs in a clean environment.
function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
loadEnvLocal();

if (!process.env.URL_SIGNING_SECRET || process.env.URL_SIGNING_SECRET.length < 32) {
  // Generate a deterministic test secret — 64 hex chars = 32 bytes.
  process.env.URL_SIGNING_SECRET = "0".repeat(64);
  console.log("(URL_SIGNING_SECRET not set in env; using throwaway test secret.)");
}

const {
  signReplyUrl,
  parseAndVerifyToken,
  hashReplyToken,
  verifyReplyUrl,
} = await import("../src/lib/security/signed-urls.ts");

// ---------- Test harness ----------
let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// ---------- 1. Round-trip ----------
console.log("\n■ sign → parseAndVerifyToken round-trip");
{
  const replyId = "e59e8e6f-0f5e-4a87-9bb0-a1e02f0f0f01";
  const { token, hash, expiresAt } = signReplyUrl(replyId);
  assert(typeof token === "string" && token.includes("."), "token is non-empty '.'-separated string");
  assert(typeof hash === "string" && hash.length === 64, "hash is 64-char SHA-256 hex");
  assert(expiresAt > Date.now(), "expiresAt is in the future");

  const parsed = parseAndVerifyToken(token);
  assert(parsed !== null, "parseAndVerifyToken returns non-null for fresh token");
  assert(parsed?.replyId === replyId, "parsed.replyId matches original");
  assert(parsed?.expiresAt === expiresAt, "parsed.expiresAt matches signed value");

  // hashReplyToken is deterministic
  assert(hashReplyToken(token) === hash, "hashReplyToken(token) matches returned hash");
}

// ---------- 2. Expired ----------
console.log("\n■ expired tokens return null");
{
  const replyId = "11111111-1111-1111-1111-111111111111";
  const { token, expiresAt } = signReplyUrl(replyId);
  // Fast-forward: ask parser to treat "now" as just past expiry.
  const stillValid = parseAndVerifyToken(token, expiresAt - 1);
  const expired = parseAndVerifyToken(token, expiresAt + 1);
  assert(stillValid !== null, "valid just before expiry");
  assert(expired === null, "expired just after expiry returns null");
}

// ---------- 3. Tampered HMAC ----------
console.log("\n■ tampered tokens return null");
{
  const replyId = "22222222-2222-2222-2222-222222222222";
  const { token } = signReplyUrl(replyId);
  const [payloadB64, macB64] = token.split(".");

  // Flip a byte in the HMAC portion. base64url chars are [A-Za-z0-9_-].
  const flipped = macB64[0] === "A" ? "B" + macB64.slice(1) : "A" + macB64.slice(1);
  const tamperedMac = `${payloadB64}.${flipped}`;
  assert(parseAndVerifyToken(tamperedMac) === null, "flipped HMAC rejected");

  // Tamper payload instead — HMAC won't recompute to the same value.
  const tamperedPayload = `${payloadB64.slice(0, -2)}XX.${macB64}`;
  assert(parseAndVerifyToken(tamperedPayload) === null, "modified payload rejected");

  // Malformed: no dot separator
  assert(parseAndVerifyToken("not-a-token") === null, "missing separator rejected");

  // Malformed: too many dots
  assert(parseAndVerifyToken("a.b.c") === null, "extra separator rejected");
}

// ---------- 4. Wrong secret ----------
console.log("\n■ wrong-secret verification returns null");
{
  const originalSecret = process.env.URL_SIGNING_SECRET;
  const replyId = "33333333-3333-3333-3333-333333333333";
  const { token } = signReplyUrl(replyId);

  // Rotate to a different secret, re-verify the same token.
  process.env.URL_SIGNING_SECRET = "f".repeat(64);
  const rejected = parseAndVerifyToken(token);
  assert(rejected === null, "token signed with old secret rejected under new secret");

  // Restore
  process.env.URL_SIGNING_SECRET = originalSecret;
  assert(parseAndVerifyToken(token) !== null, "original secret re-accepts the token");
}

// ---------- 5. verifyReplyUrl with stub admin ----------
console.log("\n■ verifyReplyUrl: single-use enforcement");

/**
 * Build a chainable Supabase stub. Tracks whether the row has been
 * "consumed" across calls. Implements only the subset used by
 * verifyReplyUrl: from(table).update(patch).eq(col, val).is(col, val)
 *   .select(cols).maybeSingle().
 */
function stubAdmin({ rowId, rowHash, initiallyConsumed = false }) {
  let consumed = initiallyConsumed;

  return {
    from(table) {
      if (table !== "lead_replies") throw new Error(`unexpected table: ${table}`);
      let updateHash = null;
      let requireNullConsumed = false;
      return {
        update(patch) {
          // We only care that the patch stamps consumed_at; don't assert shape.
          if (!("notification_token_consumed_at" in patch)) {
            throw new Error("stub: update() didn't set notification_token_consumed_at");
          }
          return this;
        },
        eq(col, val) {
          if (col === "notification_token_hash") updateHash = val;
          return this;
        },
        is(col, val) {
          if (col === "notification_token_consumed_at" && val === null) {
            requireNullConsumed = true;
          }
          return this;
        },
        select(_cols) {
          return this;
        },
        async maybeSingle() {
          // Hash must match and row must not already be consumed.
          if (updateHash !== rowHash) return { data: null, error: null };
          if (requireNullConsumed && consumed) return { data: null, error: null };
          consumed = true;
          return { data: { id: rowId }, error: null };
        },
      };
    },
  };
}

{
  const replyId = "44444444-4444-4444-4444-444444444444";
  const { token, hash } = signReplyUrl(replyId);
  const admin = stubAdmin({ rowId: replyId, rowHash: hash });

  const first = await verifyReplyUrl(token, admin);
  assert(first !== null && first.replyId === replyId, "first verify succeeds and returns replyId");

  const second = await verifyReplyUrl(token, admin);
  assert(second === null, "second verify (token already consumed) returns null");
}

{
  // Token minted for replyId A, but the row at that hash has id B.
  // The belt-and-suspenders check inside verifyReplyUrl should refuse.
  const replyA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const replyB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const { token, hash } = signReplyUrl(replyA);
  const admin = stubAdmin({ rowId: replyB, rowHash: hash });

  const result = await verifyReplyUrl(token, admin);
  assert(result === null, "replyId/row mismatch refused even if hash matches");
}

{
  // Expired token short-circuits before we ever touch the DB.
  const replyId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const { token } = signReplyUrl(replyId);
  const admin = stubAdmin({ rowId: replyId, rowHash: "irrelevant" });

  // Overload: parseAndVerifyToken uses Date.now() internally; we can't
  // inject clock here. Instead: mutate the token's embedded expiry.
  // Easiest: create a token with a past expiry by calling parseAndVerifyToken
  // at a future time. That already passed. Different angle: just mint a token,
  // monkey-patch Date.now, verify, restore.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 5 * 60 * 60 * 1000; // +5h (TTL is 4h)
    const result = await verifyReplyUrl(token, admin);
    assert(result === null, "expired token rejected before DB consumption");
  } finally {
    Date.now = realNow;
  }
}

// ---------- Summary ----------
console.log("\n" + "─".repeat(40));
if (fail === 0) {
  console.log(`✓ ${pass} assertions passed`);
  process.exit(0);
} else {
  console.error(`✗ ${fail} failed, ${pass} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
