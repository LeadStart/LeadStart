#!/usr/bin/env node
/**
 * Unit tests for the shared Google service-account auth substrate: the
 * scope-aware cache key and the error classifiers. No network, no DB.
 * Run: npx tsx scripts/test-google-auth.ts
 */
import {
  tokenCacheKey,
  base64url,
  classifyTokenError,
  classifyApiError,
  GoogleAuthError,
  GoogleRateLimitError,
  GoogleTransientError,
  GooglePermanentError,
} from "../src/lib/google/auth.ts";
import {
  GmailAuthError,
  GmailRateLimitError,
  GmailTransientError,
  GmailConfigError,
  GmailPermanentError,
} from "../src/lib/gmail/client.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(
      `  ✗ ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
    );
  }
}

const GMAIL = "https://www.googleapis.com/auth/gmail.send";
const DIRECTORY = "https://www.googleapis.com/auth/admin.directory.user";

// ── tokenCacheKey (scope separation is the whole point) ──────────────────────
console.log("tokenCacheKey");
eq(
  tokenCacheKey("sa@x.iam", "admin@x.com", GMAIL),
  "sa@x.iam|admin@x.com|" + GMAIL,
  "key = saEmail|subject|scopes",
);
eq(
  tokenCacheKey("sa@x.iam", "admin@x.com", GMAIL) ===
    tokenCacheKey("sa@x.iam", "admin@x.com", DIRECTORY),
  false,
  "same sa+subject, different scopes → different keys (the collision fix)",
);
eq(
  tokenCacheKey("sa@x.iam", "a@x.com", GMAIL) ===
    tokenCacheKey("sa@x.iam", "b@x.com", GMAIL),
  false,
  "different subject → different key",
);

// ── base64url ────────────────────────────────────────────────────────────────
console.log("base64url");
eq(base64url("hello"), "aGVsbG8", "no padding, url-safe alphabet");
eq(base64url(Buffer.from([0xfb, 0xff])), "-_8", "+/ mapped to -_");

// ── classifyTokenError ───────────────────────────────────────────────────────
console.log("classifyTokenError");
eq(
  classifyTokenError(429, "", "s", GMAIL) instanceof GoogleRateLimitError,
  true,
  "429 → GoogleRateLimitError",
);
eq(
  classifyTokenError(503, "", "s", GMAIL) instanceof GoogleTransientError,
  true,
  "503 → GoogleTransientError",
);
{
  const e = classifyTokenError(
    401,
    JSON.stringify({ error: "unauthorized_client", error_description: "nope" }),
    "admin@x.com",
    DIRECTORY,
  ) as GoogleAuthError;
  eq(e instanceof GoogleAuthError, true, "401 → GoogleAuthError");
  eq(e.status, 401, "carries .status");
  eq(
    e.message.includes("admin@x.com") && e.message.includes(DIRECTORY),
    true,
    "message names the subject and the scopes it needs",
  );
}

// ── classifyApiError ─────────────────────────────────────────────────────────
console.log("classifyApiError");
{
  const e = classifyApiError(
    403,
    JSON.stringify({ error: { message: "Not Authorized" } }),
    "Directory",
  ) as GoogleAuthError;
  eq(e instanceof GoogleAuthError, true, "403 → GoogleAuthError");
  eq(e.status, 403, "403 carries .status");
  eq(e.message, "Directory 403: Not Authorized", "message labels the API + parses google error.message");
}
eq(
  classifyApiError(429, "", "Directory") instanceof GoogleRateLimitError,
  true,
  "429 → GoogleRateLimitError",
);
eq(
  classifyApiError(500, "", "Directory") instanceof GoogleTransientError,
  true,
  "500 → GoogleTransientError",
);
{
  const e = classifyApiError(409, "", "Directory") as GooglePermanentError;
  eq(e instanceof GooglePermanentError, true, "409 → GooglePermanentError (caller inspects .status for resume)");
  eq(e.status, 409, "409 carries .status so a step can treat it as already-exists");
}

// ── Gmail error classes still subclass the Google ones ───────────────────────
// The whole refactor rests on this: every `instanceof GmailAuthError` call
// site keeps working, and generic code can catch the Google parent.
console.log("gmail error subclassing");
eq(new GmailAuthError("x") instanceof GoogleAuthError, true, "GmailAuthError is a GoogleAuthError");
eq(new GmailRateLimitError() instanceof GoogleRateLimitError, true, "GmailRateLimitError is a GoogleRateLimitError");
eq(new GmailTransientError("x") instanceof GoogleTransientError, true, "GmailTransientError is a GoogleTransientError");
eq(new GmailPermanentError("x") instanceof GooglePermanentError, true, "GmailPermanentError is a GooglePermanentError");
eq(new GmailConfigError("x").name, "GmailConfigError", "GmailConfigError keeps its own name");
// ...but a bare GoogleAuthError is NOT a GmailAuthError — which is exactly why
// GmailClient.getAccessToken translates via asGmailError.
eq(new GoogleAuthError("x") instanceof GmailAuthError, false, "a bare GoogleAuthError is not a GmailAuthError (translation required)");

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
