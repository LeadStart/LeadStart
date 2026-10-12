#!/usr/bin/env node
/**
 * Drives the REAL decision-maker Layer 2 (src/lib/decision-maker/layer2.ts) and
 * the enrichBusiness orchestrator against a stubbed Anthropic API, to prove the
 * owner-name web lookup now runs on Claude, not Perplexity (owner decision
 * 2026-10-11):
 *   - a site that names nobody falls through to ONE Claude Haiku 5.5 web search
 *     (web_search_20250305, max_uses 1, searched from the firm's city/state) on
 *     the Anthropic key alone; nothing goes to Perplexity
 *   - the owner it finds comes back as a web_search result, and the cost counts
 *     the 1¢ search fee plus Haiku 5.5 tokens
 *   - a paused search (stop_reason "pause_turn") resumes with the assistant's
 *     content passed back unchanged
 *   - an account-level rejection (HTTP 400: web search off, bad key) finishes
 *     without a retry, since a retry would pay for Layer 1 again; a server error
 *     stays retryable ("error")
 *   - layer2CanYieldContact: no domain or no mail server means no lookup
 *
 * globalThis.fetch is stubbed: no network, no key, no cost.
 *
 * Run: npx tsx scripts/test-decision-maker-layer2.ts
 */
import { enrichWithWebSearch, layer2CanYieldContact } from "../src/lib/decision-maker/layer2.ts";
import { enrichBusiness } from "../src/lib/decision-maker/index.ts";
import { HAIKU_MODEL_ID, LAYER2_MODEL_ID } from "../src/lib/decision-maker/pricing.ts";
import type { EnrichmentInput, EnrichmentOptions } from "../src/lib/decision-maker/types.ts";

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

// ---------------------------------------------------------------- stubbed Anthropic API

type Reply = { status?: number; body: unknown };
// The parts of a Messages request this test reads.
interface RequestBody {
  model?: string;
  system?: string;
  tools?: Record<string, unknown>[];
  output_config?: unknown;
  messages?: { role: string; content: unknown }[];
}
interface Seen { url: string; headers: Headers; body: RequestBody | null }
const seen: Seen[] = [];
let layer2Replies: Reply[] = [];
const layer1Reply = (text: string): Reply => ({ body: message("claude-haiku-4-5", [{ type: "text", text }], "end_turn", { input_tokens: 900, output_tokens: 30 }) });

function message(model: string, content: unknown[], stop_reason: string, usage: Record<string, unknown>) {
  return { id: `msg_${seen.length}`, type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage };
}
const searchBlocks = (query: string) => [
  { type: "thinking", thinking: "", signature: "sig" },
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query } },
  {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_1",
    content: [{ type: "web_search_result", url: "https://www.bbb.org/us/il/springfield/profile/sunrise", title: "Sunrise Cleaning | BBB", encrypted_content: "enc", page_age: null }],
  },
];
const answer = (fields: Record<string, string>) => ({ type: "text", text: JSON.stringify(fields) });
const DANA = { first_name: "Dana", last_name: "Reyes", title: "Owner", email: "", source: "https://www.bbb.org/us/il/springfield/profile/sunrise" };
const ONE_SEARCH_USAGE = { input_tokens: 13_000, output_tokens: 400, server_tool_use: { web_search_requests: 1 } };

const SITE = `<!doctype html><html><head><title>Sunrise Cleaning</title></head><body><main><p>Homes and offices cleaned across Springfield since 2012. Call for a free quote.</p></main></body></html>`;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (url.hostname === "api.anthropic.com") {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    seen.push({ url: url.href, headers: new Headers(init?.headers), body });
    const reply: Reply =
      body.model === LAYER2_MODEL_ID
        ? layer2Replies.shift() ?? { status: 500, body: { type: "error", error: { type: "api_error", message: "no scripted reply" } } }
        : layer1Reply(JSON.stringify({ first_name: "", last_name: "", title: "", email: "" }));
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }
  seen.push({ url: url.href, headers: new Headers(init?.headers), body: null });
  if (url.hostname === "sunrise-cleaning.test") {
    return new Response(SITE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response("Not found", { status: 404 });
}) as typeof fetch;
delete process.env.ANTHROPIC_BASE_URL;

const KEY = "test-key-not-real";
const OPTS: EnrichmentOptions = { serviceType: "operations", useLayer2: true, anthropicKey: KEY };
const INPUT: EnrichmentInput = {
  business_name: "Sunrise Cleaning",
  website: "https://sunrise-cleaning.test",
  category: "House cleaning service",
  city: "Springfield",
  state: "IL",
  generic_email: null,
};
const layer2Requests = () => seen.filter((s) => s.body?.model === LAYER2_MODEL_ID);
const reset = (replies: Reply[]) => {
  seen.length = 0;
  layer2Replies = replies;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

async function main(): Promise<void> {
  console.log("layer2CanYieldContact: look up only where a found name could become a contact");
  eq(layer2CanYieldContact("sunrise.com", "microsoft365"), true, "domain + Microsoft 365 mail → look up");
  eq(layer2CanYieldContact("sunrise.com", null), true, "domain + unchecked mail host → look up");
  eq(layer2CanYieldContact("sunrise.com", "none"), false, "domain with no mail server → skip");
  eq(layer2CanYieldContact(null, "google"), false, "no domain → skip");
  eq(layer2CanYieldContact("   ", null), false, "blank domain → skip");

  console.log("\none Claude Haiku 5.5 web search, on the Anthropic key");
  reset([{ body: message(LAYER2_MODEL_ID, [...searchBlocks("Sunrise Cleaning Springfield IL owner"), answer(DANA)], "end_turn", ONE_SEARCH_USAGE) }]);
  const r = await enrichWithWebSearch(INPUT, OPTS);
  eq(`${r.first_name} ${r.last_name}`, "Dana Reyes", "the owner the search found is returned");
  eq(r.enrichment_source, "web_search", "as a web_search result");
  eq(r.status, "complete", "status complete");
  eq(r.enrichment_notes, "Claude web search (1 search)", "notes say one search ran");
  ok(near(r.cost_usd, 13_000 * 0.1e-6 + 400 * 0.5e-6 + 0.01), `cost = Haiku 5.5 tokens + the 1¢ search fee ($${r.cost_usd.toFixed(4)})`);
  const req = layer2Requests()[0];
  eq(req?.body?.model, "claude-haiku-5-5", "model claude-haiku-5-5");
  eq(req?.body?.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 1, user_location: { type: "approximate", country: "US", city: "Springfield", region: "IL" } }], "one basic web search, searched from the firm's city/state");
  eq(req?.body?.output_config, { effort: "medium" }, "effort medium");
  ok(String(req?.body?.system).startsWith("You are a business research assistant. Return ONLY valid JSON"), "JSON-only system prompt");
  ok(String(req?.body?.messages?.[0]?.content).includes("Business: Sunrise Cleaning") && String(req?.body?.messages?.[0]?.content).includes("Location: Springfield, IL"), "the Layer 2 prompt names the business and its location");
  eq(req?.headers.get("x-api-key"), KEY, "sent with the Anthropic key");
  eq(seen.filter((s) => s.url.includes("perplexity")).length, 0, "nothing goes to Perplexity");

  console.log("\nno city or state → search without a location guess");
  reset([{ body: message(LAYER2_MODEL_ID, [answer({ first_name: "", last_name: "", title: "", email: "", source: "not found" })], "end_turn", { input_tokens: 500, output_tokens: 40 }) }]);
  const nowhere = await enrichWithWebSearch({ ...INPUT, city: null, state: null }, OPTS);
  eq(layer2Requests()[0]?.body?.tools?.[0]?.user_location, { type: "approximate", country: "US" }, "location is just the country");
  eq(nowhere.first_name, null, "a not-found answer names nobody");
  eq(nowhere.status, "complete", "and completes");
  eq(nowhere.enrichment_notes, "Claude web search (0 searches)", "notes count the searches that ran");

  console.log("\na paused search resumes with the assistant's content passed back");
  const paused = [...searchBlocks("Sunrise Cleaning owner")];
  reset([
    { body: message(LAYER2_MODEL_ID, paused, "pause_turn", ONE_SEARCH_USAGE) },
    { body: message(LAYER2_MODEL_ID, [answer(DANA)], "end_turn", { input_tokens: 14_000, output_tokens: 120 }) },
  ]);
  const resumed = await enrichWithWebSearch(INPUT, OPTS);
  eq(layer2Requests().length, 2, "two requests");
  eq(layer2Requests()[1]?.body?.messages?.[1], { role: "assistant", content: paused }, "the second carries the paused content back unchanged");
  eq(`${resumed.first_name} ${resumed.last_name}`, "Dana Reyes", "and the owner is found");
  ok(near(resumed.cost_usd, (13_000 + 14_000) * 0.1e-6 + (400 + 120) * 0.5e-6 + 0.01), `both requests are costed ($${resumed.cost_usd.toFixed(4)})`);

  console.log("\nan answer that isn't JSON names nobody, without a retry");
  reset([{ body: message(LAYER2_MODEL_ID, [{ type: "text", text: "I could not find the owner of this business." }], "end_turn", ONE_SEARCH_USAGE) }]);
  const prose = await enrichWithWebSearch(INPUT, OPTS);
  eq(prose.first_name, null, "no name");
  eq(prose.status, "complete", "complete, not retried");

  console.log("\nan account-level rejection finishes; a server error stays retryable");
  reset([{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "web search is not enabled for this organization" } } }]);
  const rejected = await enrichWithWebSearch(INPUT, OPTS);
  eq(rejected.status, "complete", "HTTP 400 → complete (a retry would only pay for Layer 1 again)");
  ok(rejected.enrichment_notes.startsWith("Web search unavailable (HTTP 400)"), `the reason is recorded (${rejected.enrichment_notes.slice(0, 60)}…)`);
  eq(layer2Requests().length, 1, "asked once");
  reset([
    { status: 500, body: { type: "error", error: { type: "api_error", message: "internal error" } } },
    { status: 500, body: { type: "error", error: { type: "api_error", message: "internal error" } } },
  ]);
  const broken = await enrichWithWebSearch(INPUT, OPTS);
  eq(broken.status, "error", "HTTP 500 → error, so the naming phase retries the item later");
  eq(layer2Requests().length, 2, "after one SDK retry");

  console.log("\nenrichBusiness: a site that names nobody falls through to the web search");
  reset([{ body: message(LAYER2_MODEL_ID, [...searchBlocks("Sunrise Cleaning owner"), answer(DANA)], "end_turn", ONE_SEARCH_USAGE) }]);
  const full = await enrichBusiness(INPUT, { ...OPTS, perBusinessTimeoutMs: 30_000 });
  ok(seen.some((s) => s.body?.model === HAIKU_MODEL_ID), "Layer 1 read the site with Haiku 4.5");
  eq(`${full.first_name} ${full.last_name} via ${full.enrichment_source}`, "Dana Reyes via web_search", "Layer 2 named the owner");
  ok(full.enrichment_notes.endsWith("| Claude web search (1 search)"), `notes show both layers (${full.enrichment_notes})`);
  reset([]);
  const off = await enrichBusiness(INPUT, { ...OPTS, useLayer2: false, perBusinessTimeoutMs: 30_000 });
  eq(layer2Requests().length, 0, "useLayer2 false → no web search");
  eq(off.first_name, null, "and no name");

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
