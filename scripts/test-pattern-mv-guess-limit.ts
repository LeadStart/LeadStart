#!/usr/bin/env node
/**
 * pattern_mv's measured guess order and paid-guess limit (pattern_max_credits),
 * driven through the REAL code:
 *   1. The candidate order is the measured one (first@ → flast@ → first.last@ →
 *      firstlast@ → last@ → f.last@), and the settings normalizer gives the
 *      limit a default of 3, clamped to 1–6.
 *   2. runPatternMv against a scripted Million Verifier: the guessing stops
 *      after `maxCredits` paid answers without a hit; catch-all and unknown
 *      answers are free and don't count; a search stopped at the limit is final
 *      (not retried, which would pay for the same invalid guesses again); 6 =
 *      every pattern, the old reach.
 *   3. The REAL run-apify-enrichment cron tick: the run's waterfall_config
 *      snapshot carries the limit to Million Verifier (counted per address on a
 *      fake MV behind fetch), a run snapshotted before the setting existed gets
 *      the default, and the run banner + cost reflect the capped misses.
 *
 * Measured basis (2026-10-12, docs/PROSPECTING_FLOW.md §3): on the SaaSassins
 * national LinkedIn import, 440 of 1,181 pattern_mv people had every guess come
 * back invalid (2,631 MV credits for nothing).
 *
 * scripts/tsconfig.client-import-harness.json swaps the Supabase clients for
 * scripts/_stubs/fake-supabase.ts and fetch is replaced: nothing here can reach
 * the live project or the real Million Verifier.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.client-import-harness.json scripts/test-pattern-mv-guess-limit.ts
 */
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { EMAIL_PATTERN_LABELS, generateEmailCandidates } from "../src/lib/enrichment/email-patterns.ts";
import { runPatternMv, type PatternMvOutcome } from "../src/lib/enrichment/pattern-mv.ts";
import type { MillionVerifierClient, MillionVerifierResponse } from "../src/lib/millionverifier/client.ts";
import { normalizeEnrichmentSettings } from "../src/lib/apify/auth.ts";
import { MV_CREDIT_COST_USD, estimatePatternMvCost } from "../src/lib/apify/pricing.ts";
import { DEFAULT_ENRICHMENT_SETTINGS, type EnrichmentSettings } from "../src/types/app.ts";
import { fakeState, resetFake } from "./_stubs/fake-supabase.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "harness";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.CRON_SECRET = "harness-cron-secret";
for (const k of ["MILLIONVERIFIER_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "FINDYMAIL_API_KEY", "APIFY_API_TOKEN"]) {
  delete process.env[k];
}

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${g}, want ${w})`);
  }
}

// ── A scripted Million Verifier ─────────────────────────────────────────────
// Answers by address (default "invalid", the common miss) and records every
// address asked, in order.
type Verdict = "ok" | "invalid" | "catch_all" | "unknown" | "disposable";
const RESULT_CODE: Record<Verdict, number> = { ok: 1, catch_all: 2, unknown: 3, disposable: 5, invalid: 6 };
function mvAnswer(email: string, result: Verdict): MillionVerifierResponse {
  return {
    email,
    quality: result === "ok" ? "good" : result === "invalid" || result === "disposable" ? "bad" : "risky",
    result,
    resultcode: RESULT_CODE[result],
    subresult: result === "invalid" ? "mailbox_not_found" : result,
    free: false,
    role: false,
    didyoumean: "",
    credits: 1000,
    executiontime: 1,
    error: "",
    livemode: true,
  };
}
function scriptedClient(verdicts: Record<string, Verdict>) {
  const asked: string[] = [];
  const client = {
    async verify(email: string): Promise<MillionVerifierResponse> {
      asked.push(email);
      return mvAnswer(email, verdicts[email] ?? "invalid");
    },
  } as unknown as MillionVerifierClient;
  return { client, asked };
}
const opts = (maxCredits: number, acceptCatchAll = false) => ({
  acceptCatchAll,
  maxCredits,
  timeoutSec: 6,
  deadlineMs: Date.now() + 30_000,
  concurrency: 1,
});
async function one(
  verdicts: Record<string, Verdict>,
  maxCredits: number,
  acceptCatchAll = false,
  person: { first: string; last: string } = { first: "Jane", last: "Doe" },
): Promise<{ out: PatternMvOutcome; asked: string[] }> {
  const { client, asked } = scriptedClient(verdicts);
  const res = await runPatternMv(
    client,
    [{ id: "p", first_name: person.first, last_name: person.last, company_domain: "acme.test" }],
    opts(maxCredits, acceptCatchAll),
  );
  return { out: res.get("p") as PatternMvOutcome, asked };
}

type Row = Record<string, unknown>;
type RouteFn = (req: NextRequest) => Promise<Response>;

async function main() {
  // ── 1 ──
  console.log("\n1. Measured order + the setting");
  eq(
    generateEmailCandidates("Jane", "Doe", "acme.test"),
    ["jane@acme.test", "jdoe@acme.test", "jane.doe@acme.test", "janedoe@acme.test", "doe@acme.test", "j.doe@acme.test"],
    "candidates: first@ → flast@ → first.last@ → firstlast@ → last@ → f.last@",
  );
  eq(EMAIL_PATTERN_LABELS, ["first@", "flast@", "first.last@", "firstlast@", "last@", "f.last@"], "display labels follow the generator");
  eq(DEFAULT_ENRICHMENT_SETTINGS.pattern_max_credits, 3, "default paid-guess limit is 3");
  eq(normalizeEnrichmentSettings({}).pattern_max_credits, 3, "missing (every stored org blob today) → default 3");
  eq(normalizeEnrichmentSettings({ pattern_max_credits: 4 }).pattern_max_credits, 4, "4 kept");
  eq(normalizeEnrichmentSettings({ pattern_max_credits: "2" }).pattern_max_credits, 2, "numeric string accepted");
  eq(normalizeEnrichmentSettings({ pattern_max_credits: 0 }).pattern_max_credits, 1, "0 clamps to 1");
  eq(normalizeEnrichmentSettings({ pattern_max_credits: 9 }).pattern_max_credits, 6, "9 clamps to 6 (one per pattern)");
  eq(normalizeEnrichmentSettings({ pattern_max_credits: "lots" }).pattern_max_credits, 3, "garbage → default");
  eq(
    normalizeEnrichmentSettings({ pattern_max_credits: 5 }, { ...DEFAULT_ENRICHMENT_SETTINGS, pattern_max_credits: 2 }).pattern_max_credits,
    5,
    "a POSTed value overrides the stored one",
  );
  eq(Number(estimatePatternMvCost(10).toFixed(4)), Number((10 * 3 * MV_CREDIT_COST_USD).toFixed(4)), "estimate: 10 contacts × 3 credits");
  eq(Number(estimatePatternMvCost(1, 6).toFixed(4)), Number((6 * MV_CREDIT_COST_USD).toFixed(4)), "estimate follows the org's limit");

  // ── 2 ──
  console.log("\n2. runPatternMv with a scripted Million Verifier");
  {
    const { out, asked } = await one({}, 3);
    eq(asked, ["jane@acme.test", "jdoe@acme.test", "jane.doe@acme.test"], "all invalid, limit 3 → only the first 3 patterns are asked");
    eq(out.kind, "not_found", "→ not_found");
    eq(out.credits, 3, "→ 3 credits (was 6)");
    eq(out.kind === "not_found" && out.capped === true, true, "→ flagged capped");
    eq(
      out.kind === "not_found" ? out.note : null,
      "no deliverable address in the first 3 patterns (paid-guess limit 3)",
      "→ the note names the limit",
    );
  }
  {
    const { out, asked } = await one({}, 6);
    eq(asked.length, 6, "limit 6 → every pattern is asked (the old reach)");
    eq(out.kind === "not_found" ? [out.note, out.capped ?? false] : null, ["no deliverable address in the common patterns", false], "→ the usual note, not capped");
  }
  {
    const { out, asked } = await one({ "jdoe@acme.test": "ok" }, 3);
    eq(asked, ["jane@acme.test", "jdoe@acme.test"], "flast@ deliverable → found on the 2nd ask");
    eq(out.kind === "found" ? [out.email, out.confidence, out.credits] : null, ["jdoe@acme.test", 85, 2], "→ found, confidence 85, 2 credits");
  }
  {
    const { out, asked } = await one({ "janedoe@acme.test": "ok" }, 3);
    eq(asked.length, 3, "an address at the 4th pattern is not reached under limit 3 (the measured trade-off)");
    eq(out.kind, "not_found", "→ not_found");
  }
  {
    const { out, asked } = await one({ "jane@acme.test": "unknown", "janedoe@acme.test": "ok" }, 3);
    eq(asked.length, 4, "an unknown answer is free and doesn't count toward the limit");
    eq(out.kind === "found" ? [out.email, out.credits] : null, ["janedoe@acme.test", 3], "→ found at the 4th pattern for 3 credits");
  }
  {
    const { out, asked } = await one({ "jane@acme.test": "unknown" }, 3);
    eq(asked.length, 4, "unknown + 3 invalid → stops at the limit");
    eq(out.kind, "not_found", "→ final not_found, NOT inconclusive (a retry would re-pay the same invalid guesses)");
    eq(out.credits, 3, "→ 3 credits");
  }
  {
    const { out } = await one({ "jane@acme.test": "unknown" }, 6);
    eq(out.kind, "inconclusive", "under the limit an unknown answer still leaves the person for a retry (unchanged)");
  }
  {
    const catchAll = Object.fromEntries(generateEmailCandidates("Jane", "Doe", "acme.test").map((e) => [e, "catch_all" as Verdict]));
    const { out, asked } = await one(catchAll, 3, true);
    eq(asked.length, 6, "catch-all domain: every answer is free, so all patterns are asked");
    eq(out.kind === "found" ? [out.email, out.confidence, out.credits] : null, ["jane@acme.test", 40, 0], "→ the accepted catch-all guess is first@ (was first.last@), 0 credits");
  }
  {
    const { out, asked } = await one({}, 3, false, { first: "Jane", last: "" });
    eq(asked, ["jane@acme.test"], "a first name alone has one pattern");
    eq(out.kind === "not_found" ? [out.note, out.capped ?? false] : null, ["no deliverable address in the common patterns", false], "→ every pattern tried, not capped");
  }
  {
    const { out, asked } = await one({}, 1);
    eq([asked.length, out.credits], [1, 1], "limit 1 → one paid guess");
  }

  // ── 3 ──
  console.log("\n3. The real run-apify-enrichment cron carries the run's limit to Million Verifier");
  if ((createAdminClient() as unknown as { __fake?: boolean }).__fake !== true) {
    throw new Error("The Supabase module swap did not take: run with --tsconfig scripts/tsconfig.client-import-harness.json");
  }
  const askedByEmail = new Map<string, number>();
  const mvVerdicts: Record<string, Verdict> = {};
  let otherNetwork = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "api.millionverifier.com" && url.pathname.startsWith("/api/v3")) {
      const email = url.searchParams.get("email") ?? "";
      askedByEmail.set(email, (askedByEmail.get(email) ?? 0) + 1);
      return new Response(JSON.stringify(mvAnswer(email, mvVerdicts[email] ?? "invalid")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    otherNetwork++;
    throw new Error(`network blocked in harness: ${url.href}`);
  }) as typeof fetch;

  const { GET: cronGet } = (await import("../src/app/api/cron/run-apify-enrichment/route.ts")) as unknown as { GET: RouteFn };
  const tick = () =>
    cronGet(
      new NextRequest("http://localhost/app/api/cron/run-apify-enrichment", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    ).then((r) => r.json() as Promise<Row>);

  const ORG = "org-harness";
  const AT = "2026-10-12T00:00:00.000Z";
  const org: Row = {
    id: ORG,
    apify_api_key: "harness-apify-token",
    millionverifier_api_key: "harness-mv-key",
    millionverifier_last_error_kind: null,
    millionverifier_last_error_at: null,
    millionverifier_error_streak: 0,
    findymail_api_key: null,
    enrichment_settings: DEFAULT_ENRICHMENT_SETTINGS,
  };
  const person = (id: string, first: string, last: string): Row => ({
    id,
    organization_id: ORG,
    first_name: first,
    last_name: last,
    email: null,
    company_email: null,
    company_name: `${id} Cleaning`,
    company_domain: `${id}.test`,
    linkedin_url: `https://www.linkedin.com/in/${id}`,
    enrichment_data: { mail_host: { host: "google", mx: "aspmx.l.google.com", checked_at: AT } },
    tags: ["linkedin", "prospecting"],
    status: "new",
  });
  const item = (runId: string, c: Row): Row => ({
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
    employee_count: 120,
    email: null,
    attempts: 0,
    profile_status: "not_found",
    domain_status: "found",
    naming_status: "skipped",
    waterfall_status: "pending",
    waterfall_method: "pattern_mv",
    activity_status: "skipped",
    verify_status: null,
    cost_usd: 0,
    created_at: AT,
  });
  const run = (id: string, waterfallConfig: Row): Row => ({
    id,
    organization_id: ORG,
    created_by: "user-owner",
    profile_actor: "harvestapi~linkedin-profile-scraper",
    domain_actor: "harvestapi~linkedin-company",
    waterfall_actor: null,
    activity_actor: null,
    waterfall_config: waterfallConfig,
    run_profiles: true,
    run_domains: true,
    run_waterfall: true,
    run_activity: false,
    run_verify: false,
    run_naming: false,
    phase: "waterfall",
    status: "running",
    total_count: 2,
    cost_usd: 0,
    active_apify_run_id: null,
    active_apify_dataset_id: null,
    active_batch_started_at: null,
    active_batch_attempt: 0,
    consecutive_failures: 0,
    locked_at: null,
    started_at: AT,
    created_at: AT,
  });
  const t = () => fakeState().tables;
  const itemRow = (cid: string) => t().enrichment_run_items.find((i) => i.contact_id === cid) as Row;
  const contactRow = (cid: string) => t().contacts.find((c) => c.id === cid) as Row;
  const runRow = (rid: string) => t().enrichment_runs.find((r) => r.id === rid) as Row;
  const asksFor = (domain: string) =>
    [...askedByEmail.entries()].filter(([e]) => e.endsWith(`@${domain}`)).reduce((s, [, n]) => s + n, 0);

  {
    // Limit 2 on the run snapshot. "miss" has no deliverable pattern; "kim" is
    // reachable at flast@ (the 2nd pattern).
    const miss = person("miss", "Maria", "Lopez");
    const kim = person("kim", "Kim", "Park");
    mvVerdicts["kpark@kim.test"] = "ok";
    const config: EnrichmentSettings = { ...DEFAULT_ENRICHMENT_SETTINGS, pattern_max_credits: 2 };
    resetFake(
      {
        organizations: [org],
        contacts: [miss, kim],
        enrichment_runs: [run("run-limit-2", config as unknown as Row)],
        enrichment_run_items: [item("run-limit-2", miss), item("run-limit-2", kim)],
      },
      null,
    );
    const r = await tick();
    eq(r.status, "pattern_mv", "tick: the pattern+verify batch ran against Million Verifier");
    eq(asksFor("miss.test"), 2, "snapshot limit 2: the no-match person cost exactly 2 MV checks (was 6)");
    eq(itemRow("miss").waterfall_status, "not_found", "→ item not_found");
    eq(String(itemRow("miss").waterfall_notes), "no deliverable address in the first 2 patterns (paid-guess limit 2)", "→ note names the limit");
    eq(Number(itemRow("miss").cost_usd), 2 * MV_CREDIT_COST_USD, "→ item cost = 2 credits");
    eq(asksFor("kim.test"), 2, "the person at flast@ was found on the 2nd check");
    eq(contactRow("kim").email, "kpark@kim.test", "→ contacts.email written");
    eq(itemRow("kim").waterfall_status, "found", "→ item found");
    eq(r.capped, 1, "tick result counts 1 capped miss");
    eq(
      String(runRow("run-limit-2").progress_message).includes("1 stopped at the 2-guess limit"),
      true,
      "run banner: '1 stopped at the 2-guess limit'",
    );
    eq(Number(Number(runRow("run-limit-2").cost_usd).toFixed(6)), Number((4 * MV_CREDIT_COST_USD).toFixed(6)), "run cost = 4 credits");
  }

  {
    // A run snapshotted before the setting existed (no key) → the default 3.
    askedByEmail.clear();
    const legacy = person("legacy", "Lena", "Hart");
    const { pattern_max_credits: _omit, ...legacyConfig } = DEFAULT_ENRICHMENT_SETTINGS;
    void _omit;
    resetFake(
      {
        organizations: [org],
        contacts: [legacy],
        enrichment_runs: [run("run-legacy", legacyConfig as unknown as Row)],
        enrichment_run_items: [item("run-legacy", legacy)],
      },
      null,
    );
    await tick();
    eq(asksFor("legacy.test"), 3, "snapshot without the setting → the default limit, 3 checks (was 6)");
    eq(
      [...askedByEmail.keys()],
      ["lena@legacy.test", "lhart@legacy.test", "lena.hart@legacy.test"],
      "→ asked in the measured order: first@, flast@, first.last@",
    );
  }

  eq(otherNetwork, 0, "no network call other than the fake Million Verifier");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
