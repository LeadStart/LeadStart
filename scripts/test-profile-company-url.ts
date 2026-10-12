#!/usr/bin/env node
/**
 * The profiles phase takes the company LinkedIn page from the person's role at
 * the contact's OWN company, driven through the REAL run-apify-enrichment cron
 * against an in-memory database. That page is what the domains phase turns into
 * contacts.company_domain, and the waterfall then guesses and mails addresses on
 * that domain. The actor lists only LinkedIn's first role in `currentPosition`,
 * often a side job; in run ac01fd98 two cleaning-firm owners got their side job's
 * page this way (a realty firm, an inspection-report firm) and so its domain.
 *   1. Side job listed first with a page, the contact's own role without one
 *      (the real ac01fd98 shape): no page is stored, rather than the side job's.
 *   2. Side job listed first, the own role (in experience, ending "Present") has
 *      a page: the own page is stored on the item (slug) and the contact.
 *   3. Two current positions, the second at the contact's company: its page
 *      (numeric id) wins.
 *   4. No role at the contact's company: the first page listed, as before.
 *   5. The search already gave the item a company page: left alone.
 *   6. The domains phase would request the contact's own companies, never the
 *      side jobs'.
 *
 * The Apify run is already in flight (the harvest half of the phase), so the
 * only network calls are two GETs against a fake Apify: the run status and its
 * dataset. Anything else (an actor start, any paid provider) fails the test.
 * scripts/tsconfig.client-import-harness.json swaps the Supabase clients for
 * scripts/_stubs/fake-supabase.ts: nothing here can reach the live project.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.client-import-harness.json scripts/test-profile-company-url.ts
 */
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import * as profileHarvest from "../src/lib/apify/providers/profile-harvestapi.ts";
import { companyProvider } from "../src/lib/apify/providers/company-harvestapi.ts";
import type { ProviderItem } from "../src/lib/apify/providers/types.ts";
import { DEFAULT_ENRICHMENT_SETTINGS } from "../src/types/app.ts";
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

// ── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const ORG = "org-harness";
const STAMPED_AT = "2026-10-11T00:00:00.000Z";
const APIFY_RUN = "apify-run-profiles";
const DATASET = "dataset-profiles";
const org: Row = { id: ORG, apify_api_key: "harness-apify-token", enrichment_settings: DEFAULT_ENRICHMENT_SETTINGS };
const page = (slug: string) => `https://www.linkedin.com/company/${slug}/`;
// What the actor gives for an employer with no LinkedIn page.
const searchLink = (name: string) =>
  `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(name).replace(/%20/g, "+")}`;

// A Short-mode search lead: /in/<search id>, name + company, no company page yet.
function lead(id: string, company: string | null, over: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    first_name: `First-${id}`,
    last_name: "Owner",
    title: null,
    email: null,
    company_email: null,
    company_name: company,
    company_domain: null,
    linkedin_url: `https://www.linkedin.com/in/ACwAA${id}`,
    company_linkedin_url: null,
    enrichment_data: { linkedin_search_id: "search-1" },
    tags: ["linkedin", "prospecting"],
    status: "new",
    ...over,
  };
}

// Its item, mid profiles phase: the batch is in flight on the Apify run.
function item(c: Row): Row {
  return {
    id: `item-${c.id}`,
    run_id: "run-1",
    organization_id: ORG,
    contact_id: c.id,
    linkedin_url: c.linkedin_url,
    profile_id: `ACwAA${c.id}`,
    company_linkedin_url: c.company_linkedin_url,
    company_id: null,
    company_slug: null,
    company_name: c.company_name,
    first_name: c.first_name,
    last_name: c.last_name,
    title: null,
    company_domain: null,
    email: null,
    attempts: 0,
    waterfall_method: null,
    profile_status: "in_flight",
    profile_apify_run_id: APIFY_RUN,
    domain_status: "skipped",
    naming_status: null,
    waterfall_status: null,
    activity_status: null,
    verify_status: null,
    created_at: STAMPED_AT,
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
  waterfall_config: DEFAULT_ENRICHMENT_SETTINGS,
  // Only the profiles phase: once it harvests, the run completes.
  run_profiles: true,
  run_domains: false,
  run_waterfall: false,
  run_activity: false,
  run_verify: false,
  run_naming: false,
  phase: "profiles",
  status: "running",
  total_count: 6,
  cost_usd: 0,
  active_apify_run_id: APIFY_RUN,
  active_apify_dataset_id: DATASET,
  active_batch_started_at: new Date().toISOString(),
  active_batch_attempt: 0,
  consecutive_failures: 0,
  locked_at: null,
  started_at: STAMPED_AT,
  created_at: STAMPED_AT,
};

const present = { text: "Present" };
// One dataset item in the actor's real shape (fields as read off run ac01fd98).
function profile(c: Row, over: Row): Row {
  return {
    id: `ACoAA${c.id}`,
    firstName: c.first_name,
    lastName: c.last_name,
    headline: null,
    emails: [],
    currentPosition: [],
    experience: [],
    originalQuery: { url: c.linkedin_url },
    ...over,
  };
}
const role = (position: string, companyName: string, companyLinkedinUrl: string, endDate: unknown = present) => ({
  position,
  companyName,
  companyLinkedinUrl,
  endDate,
});

const noPage = lead("nopage", "Ever Bright Cleaning");
const ownPage = lead("ownpage", "Total Shine Cleaning");
const twoCurrent = lead("twocurrent", "GBC Facility Services LLC");
const noMatch = lead("nomatch", "Gleam Janitorial");
const searched = lead("searched", "Polish Pros", { company_linkedin_url: page("4242") });
const contacts = [noPage, ownPage, twoCurrent, noMatch, searched];

const inspections = role("Field Representative", "Mueller Inspection Reports", page("mueller-inspection-reports"));
const realty = role("Realtor", "Keller Williams Realty, Inc.", page("keller-williams-realty-llc"));
const dataset: Row[] = [
  profile(noPage, {
    currentPosition: [inspections],
    experience: [inspections, role("Business owner", "Ever Bright Cleaning", searchLink("Ever Bright Cleaning"))],
  }),
  profile(ownPage, {
    currentPosition: [realty],
    experience: [
      realty,
      role("Vice President", "Total Shine Cleaning", page("total-shine-old"), { year: 2019, text: "2019" }),
      role("President", "Total Shine Cleaning", page("total-shine-cleaning")),
    ],
  }),
  profile(twoCurrent, {
    currentPosition: [
      role("Co-Founder", "Prestige Environmental Services Group", page("prestige-environmental-services-group")),
      role("Chief Executive Officer", "GBC Facility Services", page("123456")),
    ],
  }),
  profile(noMatch, {
    currentPosition: [role("Field Representative", "Mueller Inspection Reports", searchLink("Mueller")), realty],
  }),
  profile(searched, {
    currentPosition: [realty, role("Owner", "Polish Pros", page("polish-pros"))],
  }),
];

// ── Fake Apify ──────────────────────────────────────────────────────────────

const allowed: string[] = [];
const blocked: string[] = [];
globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (method === "GET" && url.origin === "https://api.apify.com") {
    if (url.pathname === `/v2/actor-runs/${APIFY_RUN}`) {
      allowed.push(url.pathname);
      return json({ data: { id: APIFY_RUN, status: "SUCCEEDED", defaultDatasetId: DATASET, usageTotalUsd: 0.05 } });
    }
    if (url.pathname === `/v2/datasets/${DATASET}/items`) {
      allowed.push(url.pathname);
      return json(Number(url.searchParams.get("offset") ?? 0) > 0 ? [] : dataset);
    }
  }
  blocked.push(`${method} ${url.origin}${url.pathname}`);
  throw new Error(`network blocked in harness: ${method} ${url}`);
}) as typeof fetch;

// ── Scenarios ───────────────────────────────────────────────────────────────

type RouteFn = (req: NextRequest) => Promise<Response>;
const t = () => fakeState().tables;
const contact = (id: string) => t().contacts.find((c) => c.id === id) as Row;
const itemOf = (id: string) => t().enrichment_run_items.find((i) => i.contact_id === id) as Row;

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

  resetFake(
    {
      organizations: [org],
      contacts,
      enrichment_runs: [RUN],
      enrichment_run_items: contacts.map(item),
    },
    null,
  );
  const r = await tick();
  eq(r.status, "harvested", "the tick harvested the profiles batch");

  console.log("\n1. Side job listed first with a page, own role without one (the ac01fd98 shape)");
  eq(itemOf("nopage").company_linkedin_url, null, "no company page on the item, not the side job's");
  eq(itemOf("nopage").company_slug, null, "no slug for the domains phase to resolve");
  eq(contact("nopage").company_linkedin_url, null, "no company page on the contact");

  console.log("\n2. Side job listed first, own role (in experience) has a page");
  eq(itemOf("ownpage").company_linkedin_url, page("total-shine-cleaning"), "the own company's page on the item");
  eq(itemOf("ownpage").company_slug, "total-shine-cleaning", "its slug feeds the domains phase");
  eq(contact("ownpage").company_linkedin_url, page("total-shine-cleaning"), "and on the contact");

  console.log("\n3. Two current positions, the second at the contact's company");
  eq(itemOf("twocurrent").company_linkedin_url, page("123456"), "the second position's page (\"LLC\" ignored)");
  eq(itemOf("twocurrent").company_id, "123456", "its numeric id feeds the domains phase");
  eq(contact("twocurrent").company_linkedin_url, page("123456"), "and on the contact");

  console.log("\n4. No role at the contact's company: the first page listed, as before");
  eq(itemOf("nomatch").company_linkedin_url, page("keller-williams-realty-llc"), "first real page among the roles");

  console.log("\n5. The search already gave the item a page");
  eq(itemOf("searched").company_linkedin_url, page("4242"), "item page left alone");
  eq(contact("searched").company_linkedin_url, page("4242"), "contact page left alone");

  console.log("\n6. What the domains phase would request");
  const domainInput = companyProvider.buildInput(t().enrichment_run_items as unknown as ProviderItem[]) as {
    companies: string[];
  };
  eq(
    [...domainInput.companies].sort(),
    [page("123456"), page("4242"), page("keller-williams-realty-llc"), page("total-shine-cleaning")].sort(),
    "the contacts' own companies (plus the unmatched lead's first page), no side job's",
  );

  console.log("\n7. pickCompanyLinkedinUrl edge cases");
  const { pickCompanyLinkedinUrl } = profileHarvest as { pickCompanyLinkedinUrl?: (rec: Row, company: string | null) => string | null };
  eq(typeof pickCompanyLinkedinUrl, "function", "the provider exports pickCompanyLinkedinUrl");
  if (typeof pickCompanyLinkedinUrl !== "function") return report();
  eq(
    pickCompanyLinkedinUrl({ currentPosition: [realty, role("Owner", "Bright & Clean Inc.", page("bright-clean"))] }, "Bright and Clean"),
    page("bright-clean"),
    "\"&\" vs \"and\" and a trailing \"Inc.\" still match",
  );
  eq(
    pickCompanyLinkedinUrl({ currentPosition: [realty, role("Owner", "Acme", searchLink("Acme"))] }, "Acme"),
    null,
    "own role with only a search link: none, never the other role's page",
  );
  eq(
    pickCompanyLinkedinUrl({ currentPosition: [realty, role("Owner", "Acme", page("acme"))] }, null),
    page("keller-williams-realty-llc"),
    "no company name on the contact: the first page listed, as before",
  );
  eq(
    pickCompanyLinkedinUrl({ experience: [role("Owner", "Acme", page("acme-old"), { year: 2018, text: "2018" })] }, "Acme"),
    page("acme-old"),
    "only a past role at the company: not a current match, so the first page listed, as before",
  );

  report();
}

function report() {
  eq(blocked, [], "no network call beyond the fake Apify run + dataset (no actor started)");
  eq(allowed.length > 0, true, "the harvest read the fake Apify dataset");

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
