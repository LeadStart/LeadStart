#!/usr/bin/env node
/**
 * The profiles phase writes the person's job title, driven through the REAL
 * run-apify-enrichment cron against an in-memory database. A LinkedIn lead
 * sourced in Short mode has no title (the search page carries none), so the
 * profile scrape is the only place it can come from:
 *   1. Two current positions: the one at the contact's own company wins (here
 *      the second one, under a different legal suffix), not the actor's first.
 *   2. The real side-job shape (run ac01fd98, 10 of 65 profiles): the actor's
 *      `currentPosition` lists only another company's role, the contact's role
 *      sits in `experience` ending "Present"; it still wins, and a past role at
 *      the same company does not. No email here, so the title is written on
 *      the not_found path too.
 *   3. No current role at the contact's company → the first current role.
 *   4. A contact that already has a title keeps it (fill-only); the headline is
 *      still recorded as provenance.
 *   5. A lead whose scraped profile carries another id and another first name
 *      is joined by the URL we sent (the actor echoes it as originalQuery.url).
 *   6. A lead with no profile in the dataset gets no title.
 * Every title also lands on the run item, and enrichment.profile keeps the
 * headline + which role the title came from.
 *
 * The Apify run is already in flight (the harvest half of the phase), so the
 * only network calls are two GETs against a fake Apify: the run status and its
 * dataset. Anything else (an actor start, any paid provider) fails the test.
 * scripts/tsconfig.client-import-harness.json swaps the Supabase clients for
 * scripts/_stubs/fake-supabase.ts: nothing here can reach the live project.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.client-import-harness.json scripts/test-profile-title.ts
 */
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import * as profileHarvest from "../src/lib/apify/providers/profile-harvestapi.ts";
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

// A Short-mode search lead: /in/<search id>, name + company, no title, no email.
function lead(id: string, first: string, company: string, over: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    first_name: first,
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
    company_linkedin_url: null,
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
    id: `ACoAA${c.id}`, // the member id: never the search id we hold
    publicIdentifier: `${String(c.first_name).toLowerCase()}-owner`,
    linkedinUrl: `https://www.linkedin.com/in/${String(c.first_name).toLowerCase()}-owner`,
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

const dual = lead("dual", "Dana", "Sparkle Cleaning LLC");
const sidejob = lead("sidejob", "Sam", "Trustworthy Cleaning Services");
const fallback = lead("fallback", "Fran", "Gleam Janitorial");
const titled = lead("titled", "Tara", "Shine Co", { title: "Owner" });
const renamed = lead("renamed", "Bob", "Polish Pros");
const missing = lead("missing", "Max", "Nowhere Cleaning");
const contacts = [dual, sidejob, fallback, titled, renamed, missing];

const dataset: Row[] = [
  profile(dual, {
    headline: "Realtor | Founder of Sparkle Cleaning",
    emails: [{ email: "dana@sparkle.test" }],
    currentPosition: [
      { position: "Realtor", companyName: "Keller Williams Realty, Inc.", endDate: present },
      { position: "Founder & CEO", companyName: "Sparkle Cleaning, LLC", endDate: present },
    ],
  }),
  profile(sidejob, {
    headline: "Helping families buy homes",
    currentPosition: [{ position: "Realtor", companyName: "Keller Williams Realty, Inc.", endDate: present }],
    experience: [
      { position: "Realtor", companyName: "Keller Williams Realty, Inc.", endDate: present },
      { position: "Vice President", companyName: "Trustworthy Cleaning Services", endDate: { year: 2019, text: "2019" } },
      { position: "Founder & CEO", companyName: "Trustworthy Cleaning Services", endDate: present },
    ],
  }),
  profile(fallback, {
    headline: "Field rep",
    currentPosition: [{ position: "Field Representative", companyName: "Mueller Reports", endDate: present }],
  }),
  profile(titled, {
    headline: "VP at Shine",
    currentPosition: [{ position: "Vice President", companyName: "Shine Co", endDate: present }],
  }),
  profile(renamed, {
    firstName: "Robert", // the name on the profile, not the search's "Bob"
    headline: "Owner, Polish Pros",
    currentPosition: [{ position: "Owner/Operator", companyName: "Polish Pros", endDate: present }],
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
const profileBlock = (id: string) =>
  ((contact(id).enrichment_data as { enrichment?: { profile?: Row } }).enrichment?.profile ?? null) as Row | null;

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

  console.log("\n1. Two current positions: the one at the contact's company wins");
  eq(contact("dual").title, "Founder & CEO", "contacts.title is the role at Sparkle Cleaning (\"LLC\" vs \", LLC\")");
  eq(itemOf("dual").title, "Founder & CEO", "the run item carries the same title");
  eq(contact("dual").email, "dana@sparkle.test", "the profile's email still lands");
  eq(profileBlock("dual")?.headline, "Realtor | Founder of Sparkle Cleaning", "enrichment.profile keeps the headline");
  eq(profileBlock("dual")?.title_company, "Sparkle Cleaning, LLC", "enrichment.profile names the company the title came from");
  eq(profileBlock("dual")?.title_source, "company_match", "enrichment.profile: matched on the contact's company");
  eq(
    (contact("dual").enrichment_data as { enrichment?: { email?: Row } }).enrichment?.email?.provider,
    "harvestapi",
    "the email provenance written after it is kept alongside",
  );

  console.log("\n2. Side job listed first (the real ac01fd98 shape), no email");
  eq(contact("sidejob").title, "Founder & CEO", "the current company role from experience wins, not the side job");
  eq(itemOf("sidejob").title, "Founder & CEO", "the run item carries it");
  eq(itemOf("sidejob").profile_status, "not_found", "no email on the profile: item not_found, title written anyway");

  console.log("\n3. No current role at the contact's company");
  eq(contact("fallback").title, "Field Representative", "falls back to the first current role");
  eq(profileBlock("fallback")?.title_source, "first_current", "enrichment.profile says it is a fallback");

  console.log("\n4. An existing title is never overwritten");
  eq(contact("titled").title, "Owner", "contacts.title stays \"Owner\"");
  eq(profileBlock("titled")?.headline, "VP at Shine", "the headline is still recorded");
  eq(profileBlock("titled")?.title, "Vice President", "and what the profile said, for the owner to compare");

  console.log("\n5. Profile with another id and another first name: joined by the URL we sent");
  eq(contact("renamed").title, "Owner/Operator", "the title lands");
  eq(profileBlock("renamed")?.headline, "Owner, Polish Pros", "its profile block landed (the join found it)");

  console.log("\n6. No profile in the dataset");
  eq(contact("missing").title, null, "no title");
  eq(itemOf("missing").title, null, "no item title");
  eq(profileBlock("missing"), null, "no profile block");

  console.log("\n7. pickCurrentTitle edge cases");
  const { pickCurrentTitle } = profileHarvest;
  eq(typeof pickCurrentTitle, "function", "the provider exports pickCurrentTitle");
  if (typeof pickCurrentTitle !== "function") return report();
  const rec = (positions: Row[], experience: Row[] = []) => ({ currentPosition: positions, experience });
  eq(pickCurrentTitle(rec([]), "Any Co"), null, "no current role → null");
  eq(
    pickCurrentTitle(rec([{ position: "Owner", companyName: "Bright & Clean Inc." }]), "Bright and Clean")?.matchedCompany,
    true,
    "\"&\" vs \"and\" and a trailing \"Inc.\" still match",
  );
  eq(
    pickCurrentTitle(rec([], [{ position: "President", companyName: "Acme", endDate: { year: 2020, text: "2020" } }]), "Acme"),
    null,
    "a role that ended is not current",
  );
  eq(
    pickCurrentTitle({ currentPositions: [{ title: "CEO", companyName: "Acme" }] }, "Acme")?.title,
    "CEO",
    "the search actor's currentPositions[].title shape is read too",
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
