#!/usr/bin/env node
/**
 * One-off probe of the Million Verifier sandbox keys. Prints the RAW HTTP status
 * + body for every documented test key so we can pin the exact `error` strings
 * and response shapes that classifyApiError() (src/lib/millionverifier/client.ts)
 * keys off of. Sandbox keys are free: no credits are consumed, no DB touched.
 *
 * Run this FIRST, then reconcile the printed `error` values with the keyword
 * matches in classifyApiError() and the fixtures in
 * scripts/test-millionverifier-client.ts.
 *
 * Usage:
 *   npx tsx scripts/probe-millionverifier-sandbox.ts
 */

const BASE = "https://api.millionverifier.com/api/v3";

const VERIFY_KEYS = [
  "API_KEY_FOR_OK",
  "API_KEY_FOR_CATCH_ALL",
  "API_KEY_FOR_INVALID",
  "API_KEY_FOR_UNKOWN", // sic: the API spells it this way
  "API_KEY_FOR_DISPOSABLE",
  "API_KEY_FOR_UNVERIFIED",
  "API_KEY_FOR_TEST",
  "API_KEY_FOR_ERROR_NO_EMAIL",
  "API_KEY_FOR_ERROR_NO_APIKEY",
  "API_KEY_FOR_ERROR_INVALID_APIKEY",
  "API_KEY_FOR_ERROR_INSUFFICIENT_CREDITS",
  "API_KEY_FOR_ERROR_IP_ADDRESS_BLOCKED",
  "API_KEY_FOR_ERROR_INTERNAL_ERROR",
];

async function hit(label: string, url: string): Promise<void> {
  try {
    const res = await fetch(url);
    const text = await res.text();
    console.log(`\n=== ${label} ===`);
    console.log(`HTTP ${res.status}`);
    console.log(text);
  } catch (err) {
    console.log(`\n=== ${label} ===`);
    console.log(`FETCH ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  console.log("Probing Million Verifier sandbox keys (free, no credits consumed)...");
  for (const key of VERIFY_KEYS) {
    const url = `${BASE}/?api=${encodeURIComponent(key)}&email=test@example.com&timeout=10`;
    await hit(`verify ${key}`, url);
  }
  // Credits endpoint: does a sandbox key return a usable balance, or an error?
  await hit("credits API_KEY_FOR_OK", `${BASE}/credits?api=API_KEY_FOR_OK`);
  await hit(
    "credits API_KEY_FOR_ERROR_INSUFFICIENT_CREDITS",
    `${BASE}/credits?api=API_KEY_FOR_ERROR_INSUFFICIENT_CREDITS`,
  );
  console.log("\nDone. Pin the `error` strings above into classifyApiError() + the client test.");
}

void main();
