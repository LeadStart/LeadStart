#!/usr/bin/env node
/**
 * Profile emails at another employer are set aside, driven through the REAL
 * run-apify-enrichment cron against an in-memory database. The profile
 * scraper's email search often returns the person's address at a side job (run
 * ac01fd98: 6 of 33, e.g. a realty brokerage, a coffee franchise). When the
 * domains phase ends, every email the profiles phase wrote is checked against
 * the company's resolved domain:
 *   1. On another business domain → off contacts.email, kept in
 *      enrichment.other_employer_email with its provenance; the item drops to
 *      not_found (noting both domains) and is seeded into the waterfall, which
 *      looks for an address at the company's own domain.
 *   2. Kept: the company's own domain, a subdomain of it, a free mailbox (our
 *      list, or the actor's own `free` flag), a contact with no company domain,
 *      and an address the contact no longer holds.
 *   3. The run banner counts what was set aside.
 *   4. isOtherEmployerEmail edge cases.
 *
 * No network: the run starts at the end of the domains phase (nothing pending),
 * naming is off, and the waterfall bands are pattern_mv, which ends not_found on
 * its no-Million-Verifier-key path. fetch is replaced by a guard that fails the
 * test on any call. scripts/tsconfig.client-import-harness.json swaps the
 * Supabase clients for scripts/_stubs/fake-supabase.ts: nothing here can reach
 * the live project.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.client-import-harness.json scripts/test-other-employer-email.ts
 */
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_ENRICHMENT_SETTINGS, type EnrichmentSettings } from "../src/types/app.ts";
import { fakeState, resetFake } from "./_stubs/fake-supabase.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "harness";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.CRON_SECRET = "harness-cron-secret";
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
const STAMPED_AT = "2026-10-11T00:00:00.000Z";
// Every band guesses (pattern_mv): with no Million Verifier key it ends not_found
// without a network call.
const CONFIG: EnrichmentSettings = {
  ...DEFAULT_ENRICHMENT_SETTINGS,
  small_method: "pattern_mv",
  large_method: "pattern_mv",
  unknown_method: "pattern_mv",
};
const org: Row = { id: ORG, apify_api_key: "harness-apify-token", enrichment_settings: CONFIG };

// A LinkedIn lead whose profile scrape wrote `email` (provider harvestapi), and
// whose company domain the domains phase has resolved (or not: null).
function lead(id: string, email: string, companyDomain: string | null, profileOver: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    first_name: `First-${id}`,
    last_name: "Owner",
    title: "Owner",
    email,
    company_email: null,
    company_name: `Company ${id}`,
    company_domain: companyDomain,
    linkedin_url: `https://www.linkedin.com/in/ACwAA${id}`,
    company_linkedin_url: null,
    enrichment_data: {
      enrichment: {
        email: { provider: "harvestapi", email, confidence: 90, provider_status: null, found_at: STAMPED_AT },
        profile: { headline: `Headline ${id}`, title: "Owner", email_free: false, ...profileOver },
      },
    },
    tags: ["linkedin", "prospecting", "enriched", "apify"],
    status: "new",
  };
}

function item(c: Row, over: Row = {}): Row {
  return {
    id: `item-${c.id}`,
    run_id: "run-1",
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
    title: "Owner",
    company_domain: c.company_domain,
    employee_count: 20,
    email: c.email,
    email_provider: "harvestapi",
    confidence: 90,
    attempts: 0,
    waterfall_method: null,
    profile_status: "found",
    profile_notes: null,
    domain_status: c.company_domain ? "found" : "not_found",
    naming_status: null,
    waterfall_status: null,
    activity_status: "skipped",
    verify_status: null,
    created_at: STAMPED_AT,
    ...over,
  };
}

const RUN: Row = {
  id: "run-1",
  organization_id: ORG,
  created_by: "user-owner",
  profile_actor: "harvestapi~linkedin-profile-scraper",
  domain_actor: "harvestapi~linkedin-company",
  waterfall_actor: null,
  activity_actor: null,
  waterfall_config: CONFIG,
  run_profiles: true,
  run_domains: true,
  run_waterfall: true,
  run_activity: false,
  run_verify: false,
  run_naming: false,
  phase: "domains",
  status: "running",
  total_count: 7,
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

const sideJob = lead("sidejob", "dana@realty-brokerage.test", "sparkle-cleaning.test");
const own = lead("own", "sam@shine-cleaning.test", "shine-cleaning.test");
const sub = lead("sub", "fran@mail.gleam.test", "gleam.test");
const gmail = lead("gmail", "tara@gmail.com", "polish.test");
const isp = lead("isp", "max@smalltown-isp.test", "bright.test", { email_free: true });
const noDomain = lead("nodomain", "lee@elsewhere.test", null);
// The owner replaced the address since the profiles phase wrote it.
const changed = lead("changed", "new@elsewhere-again.test", "tidy.test");
const contacts = [sideJob, own, sub, gmail, isp, noDomain, changed];
const items = contacts.map((c) => (c === changed ? item(c, { email: "old@elsewhere.test" }) : item(c)));

// ── Scenarios ───────────────────────────────────────────────────────────────

type RouteFn = (req: NextRequest) => Promise<Response>;
const t = () => fakeState().tables;
const contact = (id: string) => t().contacts.find((c) => c.id === id) as Row;
const itemOf = (id: string) => t().enrichment_run_items.find((i) => i.contact_id === id) as Row;
const enrichment = (id: string) =>
  ((contact(id).enrichment_data as { enrichment?: Row }).enrichment ?? {}) as Record<string, Row | undefined>;

async function main() {
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

  resetFake({ organizations: [org], contacts, enrichment_runs: [RUN], enrichment_run_items: items }, null);
  await tick();
  const bannerAfterDomains = String(t().enrichment_runs[0].progress_message);

  console.log("\n1. Side-job email: set aside, and the waterfall looks at the company's own domain");
  eq(contact("sidejob").email, null, "off contacts.email");
  eq(enrichment("sidejob").other_employer_email?.email, "dana@realty-brokerage.test", "kept in enrichment.other_employer_email");
  eq(enrichment("sidejob").other_employer_email?.email_domain, "realty-brokerage.test", "with its domain");
  eq(enrichment("sidejob").other_employer_email?.company_domain, "sparkle-cleaning.test", "and the company domain it was judged against");
  eq(
    (enrichment("sidejob").other_employer_email?.found as Row | undefined)?.provider,
    "harvestapi",
    "and its original provenance",
  );
  eq(enrichment("sidejob").email, undefined, "no longer counted as the contact's email");
  eq(enrichment("sidejob").profile?.headline, "Headline sidejob", "the profile block stays");
  eq(contact("sidejob").title, "Owner", "the title stays");
  eq(itemOf("sidejob").email, null, "item email cleared");
  eq(itemOf("sidejob").email_provider, null, "item provider cleared");
  eq(itemOf("sidejob").profile_status, "not_found", "item profile_status not_found (no usable profile email)");
  eq(
    String(itemOf("sidejob").profile_notes).includes("realty-brokerage.test") &&
      String(itemOf("sidejob").profile_notes).includes("sparkle-cleaning.test"),
    true,
    "item note names both domains",
  );
  eq(itemOf("sidejob").waterfall_method, "pattern_mv", "item seeded into the waterfall");
  eq(itemOf("sidejob").waterfall_status === null, false, "with a waterfall status");

  console.log("\n2. Kept");
  for (const [id, why] of [
    ["own", "the company's own domain"],
    ["sub", "a subdomain of the company domain"],
    ["gmail", "a free mailbox (our list)"],
    ["isp", "a free mailbox (the actor's free flag)"],
    ["nodomain", "no company domain to judge by"],
  ] as const) {
    const original = contacts.find((c) => c.id === id)!.email;
    eq(contact(id).email, original, `${why}: email kept`);
    eq(itemOf(id).profile_status, "found", `${why}: item still found`);
    eq(itemOf(id).waterfall_status, null, `${why}: not sent to the waterfall`);
  }
  eq(contact("changed").email, "new@elsewhere-again.test", "an address the contact no longer holds from this run: left alone");
  eq(itemOf("changed").profile_status, "found", "and its item untouched");

  console.log("\n3. Run banner");
  eq(bannerAfterDomains.includes("1 profile email at another employer set aside"), true, `banner counts it ("${bannerAfterDomains}")`);
  eq(t().enrichment_runs[0].phase === "domains", false, "the run moved past the domains phase");

  console.log("\n4. isOtherEmployerEmail edge cases");
  let lib: typeof import("../src/lib/enrichment/other-employer-email.ts") | null = null;
  try {
    lib = await import("../src/lib/enrichment/other-employer-email.ts");
  } catch {
    lib = null;
  }
  eq(lib !== null, true, "the other-employer-email module exists");
  if (lib) {
    const { isOtherEmployerEmail } = lib;
    eq(isOtherEmployerEmail("a@kw.com", "trustworthycleaningserv.com"), true, "realty email on a cleaning firm → other employer");
    eq(isOtherEmployerEmail("a@acme.com", "www.acme.com"), false, "www. on the company domain ignored");
    eq(isOtherEmployerEmail("a@acme.com", "https://acme.com/about"), false, "a full URL as the company domain still matches");
    eq(isOtherEmployerEmail("a@Acme.COM", "acme.com"), false, "case ignored");
    eq(isOtherEmployerEmail("a@acme.com", "shop.acme.com"), false, "company domain a subdomain of the email's");
    eq(isOtherEmployerEmail("a@att.net", "acme.com"), false, "ISP mailbox on our list");
    eq(isOtherEmployerEmail("a@acme.com", null), false, "no company domain → can't judge");
    eq(isOtherEmployerEmail(null, "acme.com"), false, "no email → nothing to judge");
    eq(isOtherEmployerEmail("a@notacme.com", "acme.com"), true, "a lookalike suffix is not a subdomain");
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
