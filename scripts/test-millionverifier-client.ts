#!/usr/bin/env node
/**
 * Unit tests for src/lib/millionverifier/client.ts — the HTTP client + error
 * taxonomy. globalThis.fetch is stubbed, so no real network by default. The
 * client has no imports, so tsx loads it standalone.
 *
 * An optional live section (MV_LIVE=1) hits the free sandbox keys to confirm the
 * documented result values — no credits consumed, no DB touched.
 *
 * Usage:
 *   npx tsx scripts/test-millionverifier-client.ts
 *   MV_LIVE=1 npx tsx scripts/test-millionverifier-client.ts
 */

import {
  MillionVerifierClient,
  MillionVerifierConfigError,
  MillionVerifierCreditsError,
  MillionVerifierBlockedError,
  MillionVerifierTransientError,
  classifyApiError,
} from "../src/lib/millionverifier/client.ts";

// ---------- Test harness ----------
let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
async function assertThrows(fn: () => Promise<unknown>, ctor: Function, msg: string): Promise<void> {
  try {
    await fn();
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (did not throw)`);
  } catch (err) {
    if (err instanceof ctor) {
      pass++;
      console.log(`  ✓ ${msg}`);
    } else {
      fail++;
      failures.push(msg);
      console.log(`  ✗ ${msg} (threw ${err instanceof Error ? err.name : String(err)})`);
    }
  }
}

const realFetch = globalThis.fetch;
let lastUrl = "";
function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: unknown) => {
    lastUrl = String(input);
    return handler(lastUrl);
  }) as typeof fetch;
}
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function main(): Promise<void> {
  const client = new MillionVerifierClient("KEY");

  // ---------- classifyApiError ----------
  console.log("\nclassifyApiError:");
  assert(classifyApiError("Invalid API Key") instanceof MillionVerifierConfigError, "api key -> config/auth");
  assert(classifyApiError("Insufficient credits") instanceof MillionVerifierCreditsError, "credits -> credits");
  assert(classifyApiError("IP address blocked") instanceof MillionVerifierBlockedError, "ip blocked -> blocked");
  assert(classifyApiError("some new server error") instanceof MillionVerifierTransientError, "unknown -> transient");
  assert(classifyApiError("Insufficient credits").kind === "credits", "credits error carries kind=credits");
  assert(classifyApiError("Invalid API Key").definitive === true, "auth error is definitive");
  assert(classifyApiError("weird").definitive === false, "transient error is not definitive");
  // Real strings pinned from scripts/probe-millionverifier-sandbox.ts (2026-08-22).
  // verify uses human sentences; the credits endpoint uses snake_case codes.
  assert(classifyApiError("Apikey not found") instanceof MillionVerifierConfigError, "real: 'Apikey not found' -> config");
  assert(classifyApiError("No apikey specified") instanceof MillionVerifierConfigError, "real: 'No apikey specified' -> config");
  assert(classifyApiError("apikey_not_found") instanceof MillionVerifierConfigError, "real: credits 'apikey_not_found' -> config");
  assert(classifyApiError("IP address blocked") instanceof MillionVerifierBlockedError, "real: 'IP address blocked' -> blocked");
  assert(classifyApiError("Internal error") instanceof MillionVerifierTransientError, "real: 'Internal error' -> transient");

  // ---------- verify: happy path + result passthrough ----------
  console.log("\nverify (stubbed):");
  stubFetch(() => jsonResponse({ result: "ok", resultcode: 1, quality: "good", credits: 999, error: "" }));
  {
    const res = await client.verify("a@b.com", { timeoutSec: 8 });
    assert(res.result === "ok" && res.credits === 999, "ok response parses");
  }
  // result === "error" is a per-address verdict, NOT an account error -> returned.
  stubFetch(() => jsonResponse({ result: "error", resultcode: 4, quality: "risky", error: "" }));
  {
    const res = await client.verify("a@b.com");
    assert(res.result === "error", 'result "error" with empty error field is returned, not thrown');
  }

  // ---------- verify: account errors from the JSON `error` field ----------
  stubFetch(() => jsonResponse({ error: "Invalid API Key" }));
  await assertThrows(() => client.verify("a@b.com"), MillionVerifierConfigError, "error:Invalid API Key -> config");
  stubFetch(() => jsonResponse({ error: "Insufficient credits" }));
  await assertThrows(() => client.verify("a@b.com"), MillionVerifierCreditsError, "error:Insufficient credits -> credits");
  stubFetch(() => jsonResponse({ error: "IP address is blocked" }));
  await assertThrows(() => client.verify("a@b.com"), MillionVerifierBlockedError, "error:IP blocked -> blocked");

  // ---------- verify: transport failures -> transient ----------
  stubFetch(() => new Response("upstream boom", { status: 500 }));
  await assertThrows(() => client.verify("a@b.com"), MillionVerifierTransientError, "HTTP 500 -> transient");
  stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
  await assertThrows(() => client.verify("a@b.com"), MillionVerifierTransientError, "non-JSON body -> transient");
  globalThis.fetch = (async () => {
    throw new Error("socket hang up");
  }) as typeof fetch;
  await assertThrows(() => client.verify("a@b.com"), MillionVerifierTransientError, "network reject -> transient");
  globalThis.fetch = (async () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  }) as typeof fetch;
  await assertThrows(() => client.verify("a@b.com"), MillionVerifierTransientError, "abort -> transient");

  // ---------- verify: URL encoding + timeout param ----------
  console.log("\nURL construction:");
  stubFetch(() => jsonResponse({ result: "ok", error: "" }));
  await client.verify("a+b@x.com", { timeoutSec: 8 });
  assert(lastUrl.includes("timeout=8"), "url carries timeout=8");
  assert(lastUrl.includes("a%2Bb%40x.com"), "url percent-encodes + and @ in the address");
  // timeout clamps into [2,60]
  await client.verify("a@b.com", { timeoutSec: 999 });
  assert(lastUrl.includes("timeout=60"), "timeout clamps to 60");

  // ---------- credits ----------
  console.log("\ncredits (stubbed):");
  stubFetch(() => jsonResponse({ credits: 4242 }));
  assert((await client.credits()) === 4242, "credits returns the balance");
  stubFetch(() => jsonResponse({ error: "Insufficient credits" }));
  await assertThrows(() => client.credits(), MillionVerifierCreditsError, "credits error -> credits");

  // ---------- empty key guard ----------
  console.log("\nempty key:");
  await assertThrows(() => new MillionVerifierClient("").verify("a@b.com"), MillionVerifierConfigError, "empty key -> config error");

  globalThis.fetch = realFetch;

  // ---------- Optional live sandbox section ----------
  if (process.env.MV_LIVE === "1") {
    console.log("\nLIVE sandbox (no credits consumed):");
    const ok = await new MillionVerifierClient("API_KEY_FOR_OK").verify("test@example.com", { timeoutSec: 10 });
    assert(ok.result === "ok", "API_KEY_FOR_OK -> result ok");
    const invalid = await new MillionVerifierClient("API_KEY_FOR_INVALID").verify("test@example.com", { timeoutSec: 10 });
    assert(invalid.result === "invalid", "API_KEY_FOR_INVALID -> result invalid");
    const catchAll = await new MillionVerifierClient("API_KEY_FOR_CATCH_ALL").verify("test@example.com", { timeoutSec: 10 });
    assert(catchAll.result === "catch_all", "API_KEY_FOR_CATCH_ALL -> result catch_all");
  } else {
    console.log("\n(skipping live sandbox section — set MV_LIVE=1 to enable)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

void main();
