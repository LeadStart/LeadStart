#!/usr/bin/env node
/**
 * The company-inbox fallback add-on (company_inbox_fallback), driven through the
 * REAL code against an in-memory database:
 *   1. The REAL run-apify-enrichment cron: a NAMED lead that opted in and ends
 *      the waterfall with no personal email gets its scraped company inbox on
 *      contacts.email (company_generic provenance, confidence 30 → tier
 *      "company") and its item is seeded for the verify phase. A lead that did
 *      not opt in is left exactly as before (person-only contract), as are an
 *      opted-in lead with no inbox and one whose inbox is another contact's email.
 *   2. A run with no fallback scope (every run before the add-on, and the
 *      TuBe/law pipeline) changes nothing, whatever the contacts' stamps say.
 *   3. Contacts → Enrich with the box ticked (scope "all") applies it to every
 *      selected contact, even one imported with the add-on off.
 *   4. Routing: an opted-in named lead in a pattern-only size band (the 50+
 *      band, large_method pattern_mv) gets a site scrape first
 *      (scrape_plus_pattern); a lead that did not opt in keeps pattern_mv.
 *   5. The add-on is carried onto the run: enqueueEnrichment scopes it
 *      "opted_in" when any contact opted in, the Contacts → Enrich route scopes
 *      it "all" when the box is ticked, and neither sets it otherwise.
 *
 * No Million Verifier / Anthropic / Apify keys exist here: the waterfall's
 * pattern_mv ends "not_found" on its no-key path (a real terminal miss) and
 * naming falls straight through to waterfall seeding. Every contact carries a
 * mail-host stamp, so no DNS lookup runs, and fetch is replaced by a guard that
 * fails the test on any network call. scripts/tsconfig.client-import-harness.json
 * swaps the Supabase clients for scripts/_stubs/fake-supabase.ts: nothing here
 * can reach the live project.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.client-import-harness.json scripts/test-company-inbox-fallback.ts
 */
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { classifyEmailTier } from "../src/lib/enrichment/email-tier.ts";
import { methodForItem } from "../src/lib/enrichment/waterfall-routing.ts";
import { DEFAULT_ENRICHMENT_SETTINGS, type EnrichmentSettings } from "../src/types/app.ts";
import { fakeState, resetFake } from "./_stubs/fake-supabase.ts";

// If the module swap ever failed, a real client would get an unreachable URL
// and no service key, so it could not reach the live project either.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "harness";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.CRON_SECRET = "harness-cron-secret";
// No paid provider may be reachable: the code falls back to these env keys.
for (const k of ["MILLIONVERIFIER_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "FINDYMAIL_API_KEY", "APIFY_API_TOKEN"]) {
  delete process.env[k];
}
let networkCalls = 0;
globalThis.fetch = (async (input: unknown) => {
  networkCalls++;
  throw new Error(`network blocked in harness: ${String(input)}`);
}) as typeof fetch;

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

// ── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const ORG = "org-harness";
const OWNER = { id: "user-owner", email: "owner@harness.test", app_metadata: { role: "owner", organization_id: ORG } };
const STAMPED_AT = "2026-10-11T00:00:00.000Z";
const MAIL_HOST = { host: "google", mx: "mx.google.test", checked_at: STAMPED_AT };
// The SaaSassins shape: under 50 employees scrape first, 50+ only guess.
const SAAS_CONFIG: EnrichmentSettings = {
  ...DEFAULT_ENRICHMENT_SETTINGS,
  size_threshold: 50,
  small_method: "scrape_plus_pattern",
  large_method: "pattern_mv",
  unknown_method: "pattern_mv",
};

const org: Row = { id: ORG, apify_api_key: "harness-apify-token", enrichment_settings: SAAS_CONFIG };

// A named LinkedIn lead at a cleaning company. `addons` is the import-time stamp.
function lead(id: string, addons: Row, over: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    first_name: `First${id.length}`,
    last_name: "Owner",
    email: null,
    company_email: null,
    company_name: `Company ${id}`,
    company_domain: `${id}.test`,
    linkedin_url: `https://www.linkedin.com/in/${id}`,
    company_linkedin_url: null,
    enrichment_data: { addons, mail_host: MAIL_HOST, linkedin_search_id: "search-1" },
    tags: ["linkedin", "prospecting"],
    status: "new",
    enrich_queued_at: null,
    ...over,
  };
}

// The contact's item, the way the profiles phase left it (no email on the
// profile) and the waterfall seeded it.
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
    created_at: STAMPED_AT,
    ...over,
  };
}

function run(id: string, phase: string, waterfallConfig: Row): Row {
  return {
    id,
    organization_id: ORG,
    created_by: OWNER.id,
    profile_actor: "harvestapi~linkedin-profile-scraper",
    domain_actor: "harvestapi~linkedin-company",
    waterfall_actor: null,
    activity_actor: null,
    waterfall_config: waterfallConfig,
    run_profiles: true,
    run_domains: true,
    run_waterfall: true,
    run_activity: false,
    run_verify: true,
    run_naming: false,
    phase,
    status: "running",
    total_count: 0,
    cost_usd: 0,
    active_apify_run_id: null,
    active_apify_dataset_id: null,
    active_batch_started_at: null,
    active_batch_attempt: 0,
    consecutive_failures: 0,
    locked_at: null,
    started_at: STAMPED_AT,
    created_at: STAMPED_AT,
  };
}

const t = () => fakeState().tables;
const contact = (id: string) => t().contacts.find((c) => c.id === id) as Row;
const itemOf = (id: string) => t().enrichment_run_items.find((i) => i.contact_id === id) as Row;
const runRow = (id: string) => t().enrichment_runs.find((r) => r.id === id) as Row;
const emailBlock = (id: string) =>
  ((contact(id).enrichment_data as { enrichment?: { email?: Row } }).enrichment?.email ?? null) as Row | null;
const tierOf = (id: string) => {
  const c = contact(id);
  const e = emailBlock(id);
  return classifyEmailTier({
    email: c.email as string | null,
    company_email: c.company_email as string | null,
    email_kind: (e?.kind as string | undefined) ?? null,
    email_provider_status: (e?.provider_status as string | undefined) ?? null,
  });
};

// ── Scenarios ───────────────────────────────────────────────────────────────

type RouteFn = (req: NextRequest) => Promise<Response>;
type EnqueueFn = typeof import("../src/lib/apify/enqueue-enrichment.ts").enqueueEnrichment;

async function main() {
  if ((createAdminClient() as unknown as { __fake?: boolean }).__fake !== true) {
    throw new Error("The Supabase module swap did not take: run with --tsconfig scripts/tsconfig.client-import-harness.json");
  }
  const { GET: cronGet } = (await import("../src/app/api/cron/run-apify-enrichment/route.ts")) as unknown as { GET: RouteFn };
  const { POST: enrichStart } = (await import("../src/app/api/admin/contacts/enrich/start/route.ts")) as unknown as {
    POST: RouteFn;
  };
  const { enqueueEnrichment } = (await import("../src/lib/apify/enqueue-enrichment.ts")) as { enqueueEnrichment: EnqueueFn };
  const admin = createAdminClient();
  const tick = () =>
    cronGet(
      new NextRequest("http://localhost/app/api/cron/run-apify-enrichment", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    ).then((r) => r.json() as Promise<Row>);

  // ── 1 ──
  console.log("\n1. Opted-in named lead, waterfall ends with no personal email (run scope opted_in)");
  {
    const opted = lead("sparkle", { company_inbox_fallback: true, verify: true }, { company_email: "info@sparkle.test" });
    const notOpted = lead("shine", { verify: true }, { company_email: "info@shine.test" });
    const noInbox = lead("polish", { company_inbox_fallback: true, verify: true });
    const twin = lead("twin", { company_inbox_fallback: true, verify: true }, { company_email: "office@twin.test" });
    // Not in the run: already holds twin's inbox as its own email.
    const holder = lead("holder", {}, { email: "office@twin.test", linkedin_url: null });
    const R = "run-opted";
    resetFake(
      {
        organizations: [org],
        contacts: [opted, notOpted, noInbox, twin, holder],
        enrichment_runs: [run(R, "waterfall", { ...SAAS_CONFIG, company_inbox_fallback: "opted_in" })],
        enrichment_run_items: [item(R, opted), item(R, notOpted), item(R, noInbox), item(R, twin)],
      },
      null,
    );
    const r1 = await tick();
    eq(r1.status, "no_mv_key", "tick 1: pattern_mv has no Million Verifier key, so every guess ends not_found");
    eq(itemOf("sparkle").waterfall_status, "not_found", "tick 1: the opted-in lead's waterfall ended with no personal email");
    await tick();
    eq(contact("sparkle").email, "info@sparkle.test", "opted in: the company inbox is on contacts.email");
    eq(emailBlock("sparkle")?.kind, "company_generic", "opted in: provenance kind company_generic");
    eq(emailBlock("sparkle")?.provider, "site_scrape", "opted in: provenance provider site_scrape");
    eq(emailBlock("sparkle")?.confidence, 30, "opted in: confidence 30");
    eq(emailBlock("sparkle")?.via, "company_inbox_fallback", "opted in: marked as the named-lead fallback");
    eq(tierOf("sparkle"), "company", "opted in: tiered Company inbox, never a personal email");
    eq(((contact("sparkle").tags as string[]) ?? []).includes("enriched"), true, "opted in: tagged enriched");
    eq(itemOf("sparkle").waterfall_status, "found", "opted in: waterfall item found");
    eq(itemOf("sparkle").email, "info@sparkle.test", "opted in: item carries the inbox");
    eq(itemOf("sparkle").confidence, 30, "opted in: item confidence 30");
    eq(
      String(itemOf("sparkle").waterfall_notes).includes("Million Verifier key required"),
      true,
      "opted in: item keeps why the personal-email search missed",
    );
    eq(itemOf("sparkle").verify_status, "pending", "opted in: seeded for the Million Verifier verify phase");
    eq(runRow(R).phase, "verify", "the run moved on to verify");
    eq(String(runRow(R).progress_message).includes("1 company inbox filled"), true, "the run banner counts the inbox");

    eq(contact("shine").email, null, "not opted in: contacts.email stays empty (person-only contract)");
    eq(emailBlock("shine"), null, "not opted in: no email provenance written");
    eq(contact("shine").company_email, "info@shine.test", "not opted in: the inbox stays in company_email only");
    eq(itemOf("shine").waterfall_status, "not_found", "not opted in: item still not_found");
    eq(itemOf("shine").verify_status, null, "not opted in: nothing to verify");

    eq(contact("polish").email, null, "opted in, no inbox captured: still no email");
    eq(itemOf("polish").waterfall_status, "not_found", "opted in, no inbox captured: item still not_found");

    eq(contact("twin").email, null, "opted in, inbox already another contact's email: left without one");
    eq(itemOf("twin").waterfall_status, "skipped", "opted in, inbox taken: item skipped");
    eq(
      String(itemOf("twin").waterfall_notes).startsWith("company inbox already belongs to another contact"),
      true,
      "opted in, inbox taken: the note says why",
    );
    eq(contact("holder").email, "office@twin.test", "the contact holding that inbox is untouched");
  }

  // ── 2 ──
  console.log("\n2. A run with no fallback scope (before the add-on; the TuBe/law pipeline) changes nothing");
  {
    const stamped = lead("gleam", { company_inbox_fallback: true, verify: true }, { company_email: "info@gleam.test" });
    const R = "run-default";
    resetFake(
      {
        organizations: [org],
        contacts: [stamped],
        enrichment_runs: [run(R, "waterfall", { ...SAAS_CONFIG })],
        enrichment_run_items: [item(R, stamped)],
      },
      null,
    );
    await tick();
    await tick();
    eq(contact("gleam").email, null, "contacts.email stays empty");
    eq(itemOf("gleam").waterfall_status, "not_found", "item still not_found");
    eq(runRow(R).phase, "complete", "the run finishes normally (nothing to verify)");
  }

  // ── 3 ──
  console.log("\n3. Contacts → Enrich with the box ticked (scope all) covers a lead imported with it off");
  {
    const importedOff = lead("bright", { company_inbox_fallback: false, verify: true }, { company_email: "hello@bright.test" });
    const R = "run-all";
    resetFake(
      {
        organizations: [org],
        contacts: [importedOff],
        enrichment_runs: [run(R, "waterfall", { ...SAAS_CONFIG, company_inbox_fallback: "all" })],
        enrichment_run_items: [item(R, importedOff)],
      },
      null,
    );
    await tick();
    await tick();
    eq(contact("bright").email, "hello@bright.test", "the inbox is on contacts.email");
    eq(tierOf("bright"), "company", "tiered Company inbox");
  }

  // ── 4 ──
  console.log("\n4. Routing: opted-in leads in a pattern-only band get a site scrape first");
  eq(methodForItem(SAAS_CONFIG, 120, true, { companyInbox: true }), "scrape_plus_pattern", "50+ band, opted in → scrape_plus_pattern");
  eq(methodForItem(SAAS_CONFIG, 120, true), "pattern_mv", "50+ band, not opted in → pattern_mv (unchanged)");
  eq(methodForItem(SAAS_CONFIG, 20, true, { companyInbox: true }), "scrape_plus_pattern", "small band already scrapes: unchanged");
  eq(methodForItem(SAAS_CONFIG, 120, false, { companyInbox: true }), "site_scrape", "name-less: site_scrape as always");
  eq(methodForItem({ ...SAAS_CONFIG, large_method: "bovi" }, 120, true, { companyInbox: true }), "bovi", "bovi band left as configured");
  eq(methodForItem({ ...SAAS_CONFIG, large_method: "off" }, 120, true, { companyInbox: true }), "off", "off band stays off");
  {
    const bigOpted = lead("bigopted", { company_inbox_fallback: true });
    const bigNot = lead("bignot", {});
    const unknownOpted = lead("unknownopted", { company_inbox_fallback: true });
    const R = "run-route";
    const seed = (c: Row, employees: number | null) =>
      item(R, c, { employee_count: employees, waterfall_status: null, waterfall_method: null });
    resetFake(
      {
        organizations: [org],
        contacts: [bigOpted, bigNot, unknownOpted],
        // Naming finds no work (no Anthropic key) and falls through to waterfall seeding.
        enrichment_runs: [run(R, "naming", { ...SAAS_CONFIG, company_inbox_fallback: "opted_in" })],
        enrichment_run_items: [seed(bigOpted, 120), seed(bigNot, 120), seed(unknownOpted, null)],
      },
      null,
    );
    await tick();
    eq(runRow(R).phase, "waterfall", "the run reached the waterfall");
    eq(itemOf("bigopted").waterfall_method, "scrape_plus_pattern", "120 employees, opted in: scrape first");
    eq(itemOf("bignot").waterfall_method, "pattern_mv", "120 employees, not opted in: pattern_mv");
    eq(itemOf("unknownopted").waterfall_method, "scrape_plus_pattern", "unknown size (pattern_mv band), opted in: scrape first");
  }

  // ── 5 ──
  console.log("\n5. The add-on is carried onto the run");
  {
    const optedIn = lead("optin", { company_inbox_fallback: true });
    const plain = lead("plain", {});
    resetFake({ organizations: [org], profiles: [], contacts: [optedIn, plain], enrichment_runs: [], enrichment_run_items: [] }, null);
    const r = await enqueueEnrichment(admin, { organizationId: ORG, userId: OWNER.id, contactIds: ["optin", "plain"] });
    eq(r.status, "started", "enqueueEnrichment starts a run");
    const cfg = (t().enrichment_runs[0]?.waterfall_config ?? {}) as Row;
    eq(cfg.company_inbox_fallback, "opted_in", "one contact opted in → run scope opted_in");

    resetFake({ organizations: [org], profiles: [], contacts: [plain], enrichment_runs: [], enrichment_run_items: [] }, null);
    await enqueueEnrichment(admin, { organizationId: ORG, userId: OWNER.id, contactIds: ["plain"] });
    eq(
      ((t().enrichment_runs[0]?.waterfall_config ?? {}) as Row).company_inbox_fallback,
      undefined,
      "nobody opted in → no scope on the run",
    );

    const post = (body: Row) =>
      enrichStart(
        new NextRequest("http://localhost/app/api/admin/contacts/enrich/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    resetFake({ organizations: [org], contacts: [plain], enrichment_runs: [], enrichment_run_items: [] }, OWNER);
    const res = await post({ contact_ids: ["plain"], company_inbox_fallback: true });
    eq(res.status, 200, "Contacts → Enrich starts a run");
    eq(((t().enrichment_runs[0]?.waterfall_config ?? {}) as Row).company_inbox_fallback, "all", "box ticked → run scope all");

    resetFake({ organizations: [org], contacts: [plain], enrichment_runs: [], enrichment_run_items: [] }, OWNER);
    await post({ contact_ids: ["plain"] });
    eq(
      ((t().enrichment_runs[0]?.waterfall_config ?? {}) as Row).company_inbox_fallback,
      undefined,
      "box not ticked → no scope on the run",
    );
  }

  eq(networkCalls, 0, "no network call was attempted");

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
