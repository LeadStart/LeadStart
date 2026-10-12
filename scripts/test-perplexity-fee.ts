#!/usr/bin/env node
/**
 * Perplexity's per-request fee and the per-provider cost split (migration
 * 00138), driven through the REAL code:
 *   1. callPerplexity: a call costs its tokens plus the 0.5¢ request fee (until
 *      2026-10-12 it was tokens only, so every run's cost_usd left the fee out).
 *   2. The REAL run-apify-enrichment cron, domains phase: each website lookup
 *      adds tokens + 0.5¢ to the run's cost_usd and to its Perplexity share; two
 *      rows for one firm in one batch share one call and one fee.
 *   3. The naming phase (Claude since 2026-10-11, de633d2): the Haiku tokens and
 *      the 1¢ web search fee go to the Anthropic share; nothing reaches Perplexity.
 *   4. The verify phase adds Million Verifier credits to the same run: the shares
 *      build up and add up to cost_usd.
 *   5. The split rules (run-cost.ts): default-safe reads of runs from before the
 *      split, the completion-time Apify reconcile, the not-split part.
 *   6. Counting a past run's Perplexity calls from its notes (perplexity-calls.ts),
 *      as the TuBe report and the fee backfill do; 2b checks the count on the
 *      notes the cron itself just wrote.
 *
 * globalThis.fetch is stubbed (Perplexity, Anthropic, Million Verifier, the
 * firm's site; anything else fails the test), and
 * scripts/tsconfig.client-import-harness.json swaps the Supabase clients for
 * scripts/_stubs/fake-supabase.ts: nothing here reaches the network or the live
 * project, and no key is real.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.client-import-harness.json scripts/test-perplexity-fee.ts
 */
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { callPerplexity } from "../src/lib/perplexity/client.ts";
import {
  HAIKU_MODEL_ID,
  LAYER2_MODEL_ID,
  WEB_SEARCH_COST_USD,
  calculateCost,
  perplexityCallCost,
} from "../src/lib/decision-maker/pricing.ts";
import { MV_CREDIT_COST_USD } from "../src/lib/apify/pricing.ts";
import { addCosts, costShares, readCostBreakdown, reconcileApifyCost, unsplitCost } from "../src/lib/enrichment/run-cost.ts";
import {
  PERPLEXITY_FEE_USD,
  countLookupCalls,
  countNamingCalls,
  isPerplexityNamingNote,
  lookupCallsInNote,
  perplexityFeeRecorded,
  type LookupItemRow,
} from "../src/lib/enrichment/perplexity-calls.ts";
import { discoveryLocation } from "../src/lib/enrichment/domain-discovery.ts";
import { DEFAULT_ENRICHMENT_SETTINGS } from "../src/types/app.ts";
import { fakeState, resetFake } from "./_stubs/fake-supabase.ts";

// If the module swap ever failed, a real client would get an unreachable URL
// and no service key, so it could not reach the live project either.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "harness";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.CRON_SECRET = "harness-cron-secret";
// Keys come from the org row below; no env key may stand in for one.
for (const k of ["MILLIONVERIFIER_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "FINDYMAIL_API_KEY", "APIFY_API_TOKEN", "ANTHROPIC_BASE_URL"]) {
  delete process.env[k];
}

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ""}`);
  }
}
function eq<T>(got: T, want: T, msg: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(g === w, msg, `got:  ${g}\n      want: ${w}`);
}
const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9;
function usd(got: unknown, want: number, msg: string) {
  const n = typeof got === "string" ? Number(got) : got;
  ok(near(n, want), `${msg} ($${want.toFixed(6)})`, `got: ${JSON.stringify(got)}`);
}

// ── Stubbed providers ───────────────────────────────────────────────────────

interface Seen { host: string; body: Record<string, unknown> | null }
const seen: Seen[] = [];
const hits = (host: string) => seen.filter((s) => s.host === host);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A website lookup Perplexity answers: 250 prompt + 50 completion tokens.
const PPLX_USAGE = { prompt_tokens: 250, completion_tokens: 50 };
const LOOKUP_USD = 250 * 1e-6 + 50 * 1e-6 + 0.005; // sonar $1/M in, $1/M out, + the 0.5¢ fee
function lookupAnswer(prompt: string) {
  return prompt.includes("Business: Sunrise Cleaning")
    ? { domain: "sunrisecleaning.com", confidence: "high", source_url: "https://sunrisecleaning.com/about", evidence: "The site names Sunrise Cleaning of Springfield." }
    : { domain: null, confidence: null, source_url: null, evidence: "not found" };
}

// Naming: Layer 1 (Haiku 4.5) reads the site and names nobody; Layer 2 (Haiku
// 5.5, one web search) names the owner.
const L1_USAGE = { input_tokens: 900, output_tokens: 30 };
const L2_USAGE = { input_tokens: 13_000, output_tokens: 400, server_tool_use: { web_search_requests: 1 } };
const message = (model: string, content: unknown[], usage: Record<string, unknown>) => ({
  id: `msg_${seen.length}`, type: "message", role: "assistant", model, content, stop_reason: "end_turn", stop_sequence: null, usage,
});
const SITE = `<!doctype html><html><head><title>Sunrise Cleaning</title></head><body><main><p>Homes and offices cleaned across Springfield since 2012. Call for a free quote.</p></main></body></html>`;
const OWNER = { first_name: "Dana", last_name: "Reyes", title: "Owner", email: "", source: "https://www.bbb.org/us/il/springfield/profile/sunrise" };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  seen.push({ host: url.hostname, body });
  if (url.hostname === "api.perplexity.ai") {
    const messages = (body?.messages ?? []) as { content: string }[];
    const answer = lookupAnswer(messages[messages.length - 1]?.content ?? "");
    return json({
      id: "pplx-1",
      model: "sonar",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(answer) } }],
      usage: PPLX_USAGE,
      citations: answer.source_url ? [answer.source_url] : [],
    });
  }
  if (url.hostname === "api.anthropic.com") {
    if (body?.model === LAYER2_MODEL_ID) {
      return json(message(LAYER2_MODEL_ID, [{ type: "text", text: JSON.stringify(OWNER) }], L2_USAGE));
    }
    const nobody = JSON.stringify({ first_name: "", last_name: "", title: "", email: "" });
    return json(message(HAIKU_MODEL_ID, [{ type: "text", text: nobody }], L1_USAGE));
  }
  if (url.hostname === "api.millionverifier.com") {
    return json({
      email: url.searchParams.get("email"), quality: "good", result: "ok", resultcode: 1, subresult: "",
      free: false, role: false, didyoumean: "", credits: 9_999, executiontime: 1, error: "", livemode: true,
    });
  }
  if (url.hostname === "sunrise-cleaning.test") {
    return new Response(SITE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  throw new Error(`network blocked in harness: ${url.href}`);
}) as typeof fetch;

// ── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const ORG = "org-harness";
const STAMPED_AT = "2026-10-12T00:00:00.000Z";
const org: Row = {
  id: ORG,
  apify_api_key: "harness-apify-token",
  perplexity_api_key: "harness-perplexity-key",
  anthropic_api_key: "harness-anthropic-key",
  millionverifier_api_key: "harness-mv-key",
  enrichment_settings: DEFAULT_ENRICHMENT_SETTINGS,
};

function run(id: string, phase: string, over: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    created_by: "user-owner",
    profile_actor: "harvestapi~linkedin-profile-scraper",
    domain_actor: "harvestapi~linkedin-company",
    waterfall_actor: null,
    activity_actor: null,
    waterfall_config: { ...DEFAULT_ENRICHMENT_SETTINGS },
    run_profiles: true,
    run_domains: true,
    run_waterfall: false,
    run_activity: false,
    run_verify: false,
    run_naming: false,
    phase,
    status: "running",
    total_count: 0,
    cost_usd: 0,
    cost_breakdown: {},
    active_apify_run_id: null,
    active_apify_dataset_id: null,
    active_batch_started_at: null,
    active_batch_attempt: 0,
    consecutive_failures: 0,
    locked_at: null,
    started_at: STAMPED_AT,
    created_at: STAMPED_AT,
    ...over,
  };
}

function contact(id: string, over: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    first_name: null,
    last_name: null,
    title: null,
    email: null,
    company_email: null,
    company_name: null,
    company_domain: null,
    location: null,
    linkedin_url: null,
    company_linkedin_url: null,
    enrichment_data: {},
    tags: [],
    status: "new",
    ...over,
  };
}

function item(runId: string, c: Row, over: Row = {}): Row {
  return {
    id: `item-${c.id}`,
    run_id: runId,
    organization_id: ORG,
    contact_id: c.id,
    linkedin_url: c.linkedin_url,
    profile_id: null,
    company_linkedin_url: null,
    company_id: null,
    company_slug: null,
    company_name: c.company_name,
    first_name: c.first_name,
    last_name: c.last_name,
    company_domain: c.company_domain,
    email: c.email,
    attempts: 0,
    waterfall_method: null,
    profile_status: "skipped",
    domain_status: "skipped",
    naming_status: null,
    waterfall_status: null,
    activity_status: null,
    verify_status: null,
    cost_usd: 0,
    created_at: STAMPED_AT,
    ...over,
  };
}

const t = () => fakeState().tables;
const runRow = (id: string) => t().enrichment_runs.find((r) => r.id === id) as Row;
const itemRow = (id: string) => t().enrichment_run_items.find((i) => i.id === id) as Row;
const contactRow = (id: string) => t().contacts.find((c) => c.id === id) as Row;

type RouteFn = (req: NextRequest) => Promise<Response>;

async function main() {
  // ── 1 ──
  console.log("1. callPerplexity: tokens plus the 0.5¢ request fee");
  {
    seen.length = 0;
    const r = await callPerplexity("harness-perplexity-key", "Business: Moonlight Janitorial", "sonar", { maxTokens: 300, searchRecencyFilter: null });
    usd(r.cost, LOOKUP_USD, "a sonar call costs 250 + 50 tokens at $1/M plus $0.005");
    eq(r.usage, { input_tokens: 250, output_tokens: 50 }, "the usage it was costed from");
    eq(hits("api.perplexity.ai").length, 1, "one request");
    usd(perplexityCallCost({ input_tokens: 0, output_tokens: 0 }, "sonar"), 0.005, "the fee alone, on sonar");
    usd(perplexityCallCost({ input_tokens: 0, output_tokens: 0 }, "sonar-pro"), 0.006, "the fee alone, on sonar-pro");
    usd(perplexityCallCost({ input_tokens: 1000, output_tokens: 0 }, "claude-haiku-4-5-20251001"), 0.001, "no request fee on a model Perplexity doesn't serve");
  }

  if ((createAdminClient() as unknown as { __fake?: boolean }).__fake !== true) {
    throw new Error("The Supabase module swap did not take: run with --tsconfig scripts/tsconfig.client-import-harness.json");
  }
  const { GET: cronGet } = (await import("../src/app/api/cron/run-apify-enrichment/route.ts")) as unknown as { GET: RouteFn };
  const tick = () =>
    cronGet(
      new NextRequest("http://localhost/app/api/cron/run-apify-enrichment", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    ).then((r) => r.json() as Promise<Row>);

  // ── 2 ──
  console.log("\n2. Domains phase: each website lookup records tokens + 0.5¢ under Perplexity");
  const R = "run-lookup";
  {
    // Two LinkedIn leads at one firm (same name once "LLC" is dropped, same
    // location) and one at a firm with no website. No company LinkedIn page, so
    // the domains phase looks their websites up.
    const a1 = contact("c-a1", { first_name: "Pat", last_name: "Lee", company_name: "Sunrise Cleaning", location: "Springfield, IL" });
    const a2 = contact("c-a2", { first_name: "Sam", last_name: "Ortiz", company_name: "Sunrise Cleaning LLC", location: "Springfield, IL" });
    const b = contact("c-b", { first_name: "Kim", last_name: "Diaz", company_name: "Moonlight Janitorial", location: "Austin, TX" });
    const pending = { domain_status: "pending" };
    resetFake(
      {
        organizations: [org],
        contacts: [a1, a2, b],
        enrichment_runs: [run(R, "domains")],
        enrichment_run_items: [item(R, a1, pending), item(R, a2, pending), item(R, b, pending)],
      },
      null,
    );
    seen.length = 0;
    const r = await tick();
    eq(r.status, "domain_discovery", "the tick ran a website-lookup batch");
    eq(hits("api.perplexity.ai").length, 2, "two Perplexity calls: one per firm");
    usd(runRow(R).cost_usd, 2 * LOOKUP_USD, "run cost_usd = 2 × (tokens + 0.5¢)");
    eq(readCostBreakdown(runRow(R).cost_breakdown), { perplexity: 2 * LOOKUP_USD }, "all of it is the Perplexity share");
    usd(itemRow("item-c-b").cost_usd, LOOKUP_USD, "the firm with no website: its item carries one call");
    usd(itemRow("item-c-a1").cost_usd, LOOKUP_USD / 2, "the shared firm: each of its two items carries half the call");
    usd(itemRow("item-c-a2").cost_usd, LOOKUP_USD / 2, "  (and the other half)");
    eq(contactRow("c-a1").company_domain, "sunrisecleaning.com", "the found website is on both contacts");
    eq(contactRow("c-a2").company_domain, "sunrisecleaning.com", "  (second contact)");
    eq(itemRow("item-c-b").domain_notes, "web lookup found no website", "the miss is noted");
    ok(String(itemRow("item-c-a1").domain_notes).startsWith("discovered via sonar"), `the hit is noted (${itemRow("item-c-a1").domain_notes})`);
  }

  // ── 2b ──
  console.log("\n2b. Counting the run's Perplexity calls back from those notes (section 6's rules)");
  {
    type ContactLocation = { location?: string | null; enrichment_data?: unknown };
    const contactsById = new Map(t().contacts.map((c) => [c.id as string, c as ContactLocation]));
    const itemsHere = t().enrichment_run_items.filter((i) => i.run_id === R) as unknown as (LookupItemRow & { contact_id: string })[];
    const counted = countLookupCalls(itemsHere, (i) => discoveryLocation(contactsById.get(i.contact_id)));
    eq(counted, { items: 3, calls: 2 }, "3 lookup rows, 2 calls (the shared firm counts once)");
    eq(perplexityFeeRecorded(runRow(R) as { cost_usd: number }), true, "this run's cost already holds the fee (it has a Perplexity share)");
    eq(perplexityFeeRecorded({ cost_usd: 1.23, cost_breakdown: {} }), false, "a run recorded before the fix does not");
    eq(perplexityFeeRecorded({ cost_usd: 1.23 }), false, "nor does a row read without the column");
  }

  // ── 3 ──
  console.log("\n3. Naming phase: Haiku tokens + the 1¢ web search go to the Anthropic share");
  {
    const N = "run-naming";
    const firm = contact("c-firm", {
      company_name: "Sunrise Cleaning",
      company_domain: "sunrise-cleaning.test",
      enrichment_data: {
        city: "Springfield",
        state: "IL",
        source_row: { category: "House cleaning service" },
        mail_host: { host: "google", mx: "mx.google.test", checked_at: STAMPED_AT },
      },
    });
    resetFake(
      {
        organizations: [org],
        contacts: [firm],
        enrichment_runs: [run(N, "naming", { run_naming: true })],
        enrichment_run_items: [item(N, firm, { domain_status: "skipped", naming_status: "pending" })],
      },
      null,
    );
    seen.length = 0;
    const r = await tick();
    eq(r.status, "naming", "the tick ran a naming batch");
    eq(itemRow("item-c-firm").naming_status, "found", "the web search named the owner");
    eq(`${contactRow("c-firm").first_name} ${contactRow("c-firm").last_name}`, "Dana Reyes", "the name is on the contact");
    const want = calculateCost(L1_USAGE, HAIKU_MODEL_ID) + calculateCost(L2_USAGE, LAYER2_MODEL_ID) + WEB_SEARCH_COST_USD;
    usd(runRow(N).cost_usd, want, "run cost_usd = site read (Haiku 4.5) + web lookup (Haiku 5.5 tokens + 1¢)");
    eq(readCostBreakdown(runRow(N).cost_breakdown), { anthropic: want }, "all of it is the Anthropic share");
    eq(hits("api.perplexity.ai").length, 0, "nothing goes to Perplexity");
    eq(countNamingCalls([itemRow("item-c-firm") as { naming_notes: string | null }]), 0, "and its notes count no Perplexity naming call");
  }

  // ── 4 ──
  console.log("\n4. Verify phase: Million Verifier credits join the shares already on the run");
  {
    const V = "run-verify";
    const lead = contact("c-lead", { first_name: "Pat", last_name: "Lee", email: "pat@sunrisecleaning.com" });
    resetFake(
      {
        organizations: [org],
        contacts: [lead],
        enrichment_runs: [run(V, "verify", { run_verify: true, cost_usd: 2 * LOOKUP_USD, cost_breakdown: { perplexity: 2 * LOOKUP_USD } })],
        enrichment_run_items: [item(V, lead, { verify_status: "pending" })],
      },
      null,
    );
    seen.length = 0;
    const r = await tick();
    eq(r.status, "verify", "the tick verified");
    eq(hits("api.millionverifier.com").length, 1, "one Million Verifier call");
    eq(readCostBreakdown(runRow(V).cost_breakdown), { millionverifier: MV_CREDIT_COST_USD, perplexity: 2 * LOOKUP_USD }, "the credit is added beside the Perplexity share");
    usd(runRow(V).cost_usd, 2 * LOOKUP_USD + MV_CREDIT_COST_USD, "cost_usd is the sum of the shares");
    eq(unsplitCost(runRow(V) as { cost_usd: number }), 0, "nothing is left unsplit");
  }

  // ── 5 ──
  console.log("\n5. Split rules (run-cost.ts)");
  {
    eq(readCostBreakdown(null), {}, "null reads as no split");
    eq(readCostBreakdown("x"), {}, "a non-object reads as no split");
    eq(readCostBreakdown({ apify: "0.25", perplexity: -1, bogus: 3, anthropic: null }), { apify: 0.25 }, "numeric strings kept; negatives, unknown keys and nulls dropped");
    eq(addCosts({ cost_usd: "0.5", cost_breakdown: {} }, { apify: 0, perplexity: Number.NaN }), null, "nothing to add → no write");
    eq(
      addCosts({ cost_usd: "0.5" }, { apify: 0.1, millionverifier: 0.0037 }),
      { cost_usd: 0.6037, cost_breakdown: { apify: 0.1, millionverifier: 0.0037 } },
      "a run from before the split: the total grows, the split covers only the new charges",
    );
    eq(unsplitCost({ cost_usd: 0.6037, cost_breakdown: { apify: 0.1, millionverifier: 0.0037 } }), 0.5, "…and its earlier 50¢ stays not split");
    eq(addCosts({ cost_usd: 0.1 + 0.2, cost_breakdown: { apify: 0.1 } }, { apify: 0.2 })?.cost_breakdown, { apify: 0.3 }, "shares are kept to cost_usd's 6 decimals");
    eq(
      costShares({ cost_usd: 1, cost_breakdown: { perplexity: 0.2, apify: 0.7, findymail: 0.049 } }).map((s) => `${s.label} ${s.usd}`),
      ["Apify 0.7", "Perplexity 0.2", "Findymail 0.049"],
      "shares for display, largest first, with their labels",
    );

    console.log("   completion-time Apify reconcile");
    const accrued = { cost_usd: 1.0, cost_breakdown: { apify: 0.5, millionverifier: 0.3, perplexity: 0.2 } };
    eq(
      reconcileApifyCost(accrued, 0.8),
      { cost_usd: 1.3, cost_breakdown: { apify: 0.8, millionverifier: 0.3, perplexity: 0.2 } },
      "Apify's final usage above its share: the share and the total rise by the gap, other shares kept",
    );
    eq(reconcileApifyCost(accrued, 0.5), null, "final usage equal to the share → no change");
    eq(reconcileApifyCost(accrued, 0.4), null, "final usage below the share (a failed run's charge isn't in it) → no change");
    eq(
      reconcileApifyCost({ cost_usd: 1.0, cost_breakdown: {} }, 1.4),
      { cost_usd: 1.4, cost_breakdown: { apify: 0.4 } },
      "a run from before the split reconciles as before: total = max(total, Apify final)",
    );
    eq(reconcileApifyCost({ cost_usd: 1.0, cost_breakdown: {} }, 0.9), null, "  (and keeps a higher total)");
  }

  // ── 6 ──
  console.log("\n6. Counting rules for past runs' notes");
  {
    eq(isPerplexityNamingNote("Scraped 2 pages, found 1 email | Perplexity sonar completed"), true, "a naming lookup Perplexity answered");
    eq(isPerplexityNamingNote("web_search: Scraped 1 page, found 0 emails | Perplexity sonar completed"), true, "  (one that named the owner)");
    eq(isPerplexityNamingNote("Scraped 3 pages, found 2 emails | Claude web search (1 search)"), false, "the Claude lookup since 2026-10-11 is not one");
    eq(isPerplexityNamingNote("Layer 2 skipped, no Perplexity key configured"), false, "no key → no call");
    eq(isPerplexityNamingNote("error after 2 attempts: Lead processing timeout (30s)"), false, "a timeout isn't counted (no sign Perplexity answered)");
    eq(lookupCallsInNote("discovered via sonar: name match, source-confirmed"), 1, "found → 1 call");
    eq(lookupCallsInNote("discovered via sonar — homepage-confirmed"), 1, "found (the pre-2026-09-05 wording) → 1 call");
    eq(lookupCallsInNote("web lookup found no website"), 1, "no website → 1 call");
    eq(lookupCallsInNote("rejected: homepage does not mention the company"), 1, "rejected → 1 call");
    eq(lookupCallsInNote("inconclusive after 2 attempts: web lookup returned unparseable output"), 2, "two unparseable answers → 2 calls");
    eq(lookupCallsInNote("inconclusive after 2 attempts: web lookup error: Perplexity request timed out"), 0, "errors → none counted");
    eq(lookupCallsInNote("Perplexity API key required for website discovery (Settings → Integrations)"), 0, "no key → none");
    eq(lookupCallsInNote("matched by id"), 0, "the LinkedIn company actor's note → none");

    // Batches replay as consecutive runs of 10 claimed rows in claim order. Rows
    // born 'skipped' were never claimed, so they don't take a place in a batch.
    const at = "2026-10-12T05:00:00.000Z";
    const row = (n: number, name: string, over: Partial<LookupItemRow> = {}): LookupItemRow => ({
      id: `i${String(n).padStart(3, "0")}`, created_at: at, company_id: null, company_slug: null, company_name: name,
      domain_status: "not_found", domain_notes: "web lookup found no website", ...over,
    });
    const rows: LookupItemRow[] = [
      row(0, "Acme Cleaning"),
      ...Array.from({ length: 8 }, (_, k) => row(k + 1, `Firm ${k + 1}`)),
      row(9, "Acme Cleaning"), // same batch as row 0 → shares its call
      row(10, "Acme Cleaning"), // next batch → its own call
      row(11, "Born Skipped", { domain_status: "skipped", domain_notes: "already has company domain" }),
      row(12, "Has A Page", { company_id: "123", domain_status: "found", domain_notes: "matched by id" }),
    ];
    eq(countLookupCalls(rows, () => "Springfield, IL"), { items: 11, calls: 10 }, "one firm twice in a batch → one call; again in the next batch → another");
    eq(countLookupCalls(rows, (i) => (i.id === "i009" ? "Austin, TX" : "Springfield, IL")).calls, 11, "same name, another location → its own call");
    const shifted = [row(0, "Born Skipped", { domain_status: "skipped", domain_notes: "already has company domain" }), ...rows.slice(0, 11).map((r) => ({ ...r, id: `j${r.id}` }))];
    eq(countLookupCalls(shifted, () => "x").calls, 10, "a row that was never claimed doesn't shift the batches");
    eq(PERPLEXITY_FEE_USD, 0.005, "the fee per call on sonar");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("All pass ✓");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
