#!/usr/bin/env node
/**
 * Unit tests for the Scrap.io search guard in src/lib/scrapio/client.ts
 * (migration 00135). ~1,800 searches in three days locked the Scrap.io account
 * on 2026-09-26; every /gmap/* call must now claim a slot in the shared search
 * log first.
 *
 * Covers:
 *   1. A search is never sent without a claim: no guard, a refused claim
 *      (ok=false) or a failed claim all throw ScrapioSearchLimitError and
 *      fetch is never called.
 *   2. A claimed search is logged with its endpoint, source and parameters,
 *      and sent exactly once.
 *   3. A search is never retried: 403 (the fair-use lock), 429 and 5xx each
 *      end after one request.
 *   4. Non-search calls (/subscription) need no claim, retry only a network
 *      failure or a 5xx, and never a 403/429.
 *
 * No network, no DB (fetch and the Supabase client are stubbed).
 * Usage: npx tsx scripts/test-scrapio-search-guard.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ScrapioClient, ScrapioSearchLimitError } from "../src/lib/scrapio/client.ts";

let failed = 0;
let passed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ✗ ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  }
}

// ── stubs ────────────────────────────────────────────────────────────────────
let fetchCalls: string[] = [];
let answers: Array<Response | Error> = [];
globalThis.fetch = (async (url: string | URL) => {
  fetchCalls.push(String(url));
  const next = answers.shift() ?? new Response("{}", { status: 200 });
  if (next instanceof Error) throw next;
  return next;
}) as typeof fetch;
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

type Claim = { fn: string; args: Record<string, unknown> };
let claims: Claim[] = [];
const budget = { day: 12, week: 40, month: 90, limits: { day: 150, week: 400, month: 1000 }, left: 138 };
function admin(answer: { data: unknown; error: { message: string } | null }): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      claims.push({ fn, args });
      return answer;
    },
  } as unknown as SupabaseClient;
}
const guard = (answer: { data: unknown; error: { message: string } | null }) => ({
  admin: admin(answer),
  organizationId: "org-1",
  source: "test",
});
const OK = { data: { ...budget, ok: true }, error: null };
const FULL = { data: { ...budget, day: 150, left: 0, ok: false }, error: null };

async function attempt(fn: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error };
  }
}
function reset(...next: Array<Response | Error>) {
  fetchCalls = [];
  claims = [];
  answers = next;
}
const search = { type: "law-firm", admin1_code: "WA", city: "Seattle" };

// The repo runs .ts as CommonJS: no top-level await.
async function run() {
  // 1. No claim, no search.
  {
    reset();
    const r = await attempt(() => new ScrapioClient("k").search(search));
    check("no guard → ScrapioSearchLimitError", r.error instanceof ScrapioSearchLimitError, String(r.error));
    check("no guard → nothing sent", fetchCalls.length === 0, fetchCalls);
  }
  {
    reset();
    const r = await attempt(() => new ScrapioClient("k", guard(FULL)).search(search));
    check("full log → ScrapioSearchLimitError", r.error instanceof ScrapioSearchLimitError, String(r.error));
    check("full log → message names the window", String((r.error as Error)?.message).includes("150/150 in 24 hours"), String(r.error));
    check("full log → nothing sent", fetchCalls.length === 0, fetchCalls);
  }
  {
    reset();
    const r = await attempt(() => new ScrapioClient("k", guard({ data: null, error: { message: "function not found" } })).search(search));
    check("claim error → ScrapioSearchLimitError", r.error instanceof ScrapioSearchLimitError, String(r.error));
    check("claim error → nothing sent", fetchCalls.length === 0, fetchCalls);
  }
  {
    reset();
    const r = await attempt(() =>
      new ScrapioClient("k", guard(OK)).searchLocations({ type: "city", search_term: "Sea" }),
    );
    check("a location lookup claims too", claims.length === 1 && claims[0].args.p_endpoint === "/gmap/locations", claims);
    check("a location lookup is sent once", fetchCalls.length === 1 && !r.error, { fetchCalls, error: String(r.error ?? "") });
  }

  // 2. A claimed search is logged, then sent once.
  {
    reset(json(200, { data: [{ place_id: "p1" }], meta: {} }));
    const r = await attempt(() => new ScrapioClient("k", guard(OK)).search(search));
    check("claimed search returns the page", (r.value as { data?: unknown[] })?.data?.length === 1, r);
    check("claim goes to claim_scrapio_search", claims.length === 1 && claims[0].fn === "claim_scrapio_search", claims);
    const args = claims[0]?.args ?? {};
    check("claim carries org, endpoint and source", args.p_organization_id === "org-1" && args.p_endpoint === "/gmap/search" && args.p_source === "test", args);
    check("claim carries the search's parameters", (args.p_detail as Record<string, unknown>)?.city === "Seattle", args);
    check("sent exactly once", fetchCalls.length === 1 && fetchCalls[0].includes("/gmap/search?"), fetchCalls);
  }

  // 3. A search is never retried.
  for (const status of [403, 429, 500]) {
    reset(json(status, { error: "x" }), json(200));
    const r = await attempt(() => new ScrapioClient("k", guard(OK)).search(search));
    check(`search ${status} → throws`, Boolean(r.error) && String((r.error as Error).message).includes(String(status)), String(r.error));
    check(`search ${status} → one request, one claim`, fetchCalls.length === 1 && claims.length === 1, { fetchCalls, claims: claims.length });
  }
  {
    reset(new Error("socket hang up"), json(200));
    const r = await attempt(() => new ScrapioClient("k", guard(OK)).search(search));
    check("search network failure → throws, not retried", Boolean(r.error) && fetchCalls.length === 1, { fetchCalls, error: String(r.error) });
  }

  // 4. Non-search calls: no claim; retry only a network failure or a 5xx.
  {
    reset(json(200, { subscription: {} }));
    const r = await attempt(() => new ScrapioClient("k").getSubscription());
    check("/subscription needs no guard", !r.error && fetchCalls.length === 1 && claims.length === 0, { error: String(r.error ?? ""), fetchCalls });
  }
  for (const status of [403, 429]) {
    reset(json(status), json(200));
    const r = await attempt(() => new ScrapioClient("k").getSubscription());
    check(`/subscription ${status} → throws after one request`, Boolean(r.error) && fetchCalls.length === 1, { fetchCalls });
  }
  {
    reset(json(503), json(200, { subscription: {} }));
    const r = await attempt(() => new ScrapioClient("k").getSubscription());
    check("/subscription 503 → retried, then succeeds", !r.error && fetchCalls.length === 2, { fetchCalls, error: String(r.error ?? "") });
  }
  {
    reset(new Error("ECONNRESET"), json(200, { subscription: {} }));
    const r = await attempt(() => new ScrapioClient("k").getSubscription());
    check("/subscription network failure → retried, then succeeds", !r.error && fetchCalls.length === 2, { fetchCalls });
  }

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
