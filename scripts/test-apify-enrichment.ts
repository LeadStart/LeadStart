#!/usr/bin/env node
/**
 * Unit tests for the Apify enrichment lib — pure functions + provider mappers +
 * the HTTP client against a monkeypatched fetch. No network, no DB; imports the
 * REAL production modules by relative path (type-only "@/" cross-imports are
 * erased at runtime by tsx).
 *
 * Live smoke (only when APIFY_API_TOKEN is set): validates the token, runs one
 * profile+email batch (3 rows) and one company batch (Pritchard/Marsden/
 * CleanNet), printing raw items so the profile email field can be pinned.
 *
 * Usage:
 *   npx tsx scripts/test-apify-enrichment.ts
 */

import {
  normalizeDomain,
  registrableDomain,
  extractProfileId,
  extractCompanyId,
  extractCompanySlug,
  normalizeCompanyName,
} from "../src/lib/apify/domain.ts";
import { sanitizeFoundEmail } from "../src/lib/apify/email-sanity.ts";
import { profileProvider } from "../src/lib/apify/providers/profile-harvestapi.ts";
import { companyProvider } from "../src/lib/apify/providers/company-harvestapi.ts";
import { waterfallVdrmotaProvider } from "../src/lib/apify/providers/waterfall-vdrmota.ts";
import { waterfallBoviProvider } from "../src/lib/apify/providers/waterfall-bovi.ts";
import { activityProvider } from "../src/lib/apify/providers/activity-harvestapi.ts";
import { ApifyClient } from "../src/lib/apify/client.ts";
import type { ProviderItem } from "../src/lib/apify/providers/types.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function eq<T>(got: T, want: T, msg: string) {
  assert(got === want, `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

function item(partial: Partial<ProviderItem>): ProviderItem {
  return {
    id: "i",
    linkedin_url: null,
    profile_id: null,
    company_linkedin_url: null,
    company_id: null,
    company_slug: null,
    company_name: null,
    first_name: null,
    last_name: null,
    company_domain: null,
    email: null,
    ...partial,
  };
}

// ---------------- normalizeDomain ----------------
console.log("normalizeDomain");
eq(normalizeDomain("https://www.pritchardindustries.com/about"), "pritchardindustries.com", "strip scheme/www/path");
eq(normalizeDomain("marsden.com"), "marsden.com", "bare domain passes");
eq(normalizeDomain("http://CleanNetUSA.com:8080/x"), "cleannetusa.com", "lowercase + drop port/path");
eq(normalizeDomain("https://foo.co.uk/team"), "foo.co.uk", "multi-part TLD kept (3 labels)");
eq(normalizeDomain("https://sub.foo.co.uk"), "foo.co.uk", "registrable reduces subdomain on co.uk");
eq(normalizeDomain("https://blog.example.com"), "example.com", "registrable reduces subdomain");
eq(normalizeDomain("https://www.linkedin.com/company/x"), null, "reject linkedin");
eq(normalizeDomain("https://mycompany.wixsite.com/home"), null, "reject wixsite subdomain");
eq(normalizeDomain("http://192.168.1.1/"), null, "reject IPv4");
eq(normalizeDomain("http://localhost:3000"), null, "reject localhost");
eq(normalizeDomain("notaurl"), null, "reject no-dot host");
eq(normalizeDomain(""), null, "reject empty");
eq(normalizeDomain(null), null, "reject null");
eq(registrableDomain("a.b.example.com"), "example.com", "registrableDomain 2-label");

// ---------------- extractors ----------------
console.log("extractors");
eq(extractProfileId("https://www.linkedin.com/in/ACwAAAiqkpoBt0dbzkKpb35luHPi2l0VacCLyY0"), "ACwAAAiqkpoBt0dbzkKpb35luHPi2l0VacCLyY0", "profile URN id");
eq(extractProfileId("https://linkedin.com/company/123"), null, "profile id null for company url");
eq(extractCompanyId("https://www.linkedin.com/company/19178324"), "19178324", "numeric company id");
eq(extractCompanyId("https://www.linkedin.com/company/19178324/about/"), "19178324", "numeric company id w/ trailing path");
eq(extractCompanyId("https://www.linkedin.com/company/pritchard-industries"), null, "no numeric id for slug url");
eq(extractCompanySlug("https://www.linkedin.com/company/pritchard-industries"), "pritchard-industries", "company slug");
eq(extractCompanySlug("https://www.linkedin.com/company/19178324"), null, "slug null for numeric url");
eq(normalizeCompanyName("Pritchard Industries, LLC"), "pritchard industries", "drop legal suffix + punct");
eq(normalizeCompanyName("CleanNet USA Commercial Cleaning Services"), "cleannet usa commercial cleaning services", "keep words");

// ---------------- sanitizeFoundEmail ----------------
console.log("sanitizeFoundEmail");
{
  const ok = sanitizeFoundEmail("Mark.Salek@cleannetusa.com", { firstName: "Mark", lastName: "Salek", domain: "cleannetusa.com" });
  eq(ok.email, "mark.salek@cleannetusa.com", "valid email lowercased");
  eq(ok.rejectReason, null, "valid email not rejected");
  const junk = sanitizeFoundEmail("logo@2x.png", { firstName: "Mark", lastName: "Salek", domain: "x.com" });
  eq(junk.email, null, "junk image email rejected");
  const bad = sanitizeFoundEmail("not-an-email", { firstName: "A", lastName: "B", domain: "x.com" });
  eq(bad.email, null, "malformed rejected");
  const mism = sanitizeFoundEmail("info@othercorp.com", { firstName: "Mark", lastName: "Salek", domain: "cleannetusa.com" });
  assert(mism.email === "info@othercorp.com" && mism.flags.length >= 2, "mismatched generic email kept with flags");
}

// ---------------- profileProvider ----------------
console.log("profileProvider.parseItems");
{
  const items = [
    item({ id: "a", linkedin_url: "https://www.linkedin.com/in/ACwAAABBB", first_name: "Mark", last_name: "Salek" }),
    item({ id: "b", linkedin_url: "https://www.linkedin.com/in/ACwAAAZZZ", first_name: "No", last_name: "Match" }),
  ];
  const ds = [
    {
      id: "ACwAAABBB",
      firstName: "Mark",
      lastName: "Salek",
      email: "msalek@cleannetusa.com",
      emailStatus: "valid",
      headline: "President",
      currentPosition: [{ companyLinkedinUrl: "https://www.linkedin.com/company/371099" }],
    },
  ];
  const r = profileProvider.parseItems(ds, items);
  eq(r.get("a")?.status, "found", "profile matched by URN id");
  eq(r.get("a")?.email, "msalek@cleannetusa.com", "profile email picked");
  eq(r.get("a")?.confidence, 90, "profile confidence high when actor marks the email valid");
  eq(r.get("a")?.companyLinkedinUrl, "https://www.linkedin.com/company/371099", "company url from currentPosition");
  eq(r.get("b")?.status, "not_found", "unmatched profile → not_found");
}
{
  // name fallback + no email
  const items = [item({ id: "c", linkedin_url: "https://www.linkedin.com/in/UNKNOWNID", first_name: "Todd", last_name: "Sondag" })];
  const ds = [{ firstName: "Todd", lastName: "Sondag", headline: "VP" }];
  const r = profileProvider.parseItems(ds, items);
  eq(r.get("c")?.status, "not_found", "profile w/o email → not_found (matched by name)");
}

// ---------------- companyProvider ----------------
console.log("companyProvider.parseItems");
{
  const items = [
    item({ id: "c1", company_linkedin_url: "https://www.linkedin.com/company/19178324", company_id: "19178324", company_name: "Pritchard Industries" }),
    item({ id: "c2", company_linkedin_url: "https://www.linkedin.com/company/999", company_id: "999", company_name: "Ghost Co" }),
  ];
  const ds = [
    { id: "19178324", name: "Pritchard Industries", linkedinUrl: "https://www.linkedin.com/company/pritchard-industries", website: "https://www.pritchardindustries.com/" },
  ];
  const r = companyProvider.parseItems(ds, items);
  eq(r.get("c1")?.status, "found", "company matched by numeric id");
  eq(r.get("c1")?.companyDomain, "pritchardindustries.com", "company domain normalized");
  eq(r.get("c2")?.status, "not_found", "omitted company → not_found");
}
{
  // slug + name join, and a company with no usable website
  const items = [
    item({ id: "c3", company_linkedin_url: "https://www.linkedin.com/company/marsden", company_slug: "marsden", company_name: "Marsden Services" }),
    item({ id: "c4", company_name: "Nowebsite Inc" }),
  ];
  const ds = [
    { linkedinUrl: "https://www.linkedin.com/company/marsden", name: "Marsden Services", website: "http://marsden.com" },
    { name: "Nowebsite", website: "https://www.facebook.com/nowebsite" },
  ];
  const r = companyProvider.parseItems(ds, items);
  eq(r.get("c3")?.companyDomain, "marsden.com", "company matched by slug");
  eq(r.get("c4")?.status, "not_found", "unique-name match but social-only website → not_found");
}

// ---------------- waterfall vdrmota ----------------
console.log("waterfallVdrmotaProvider.parseItems");
{
  const items = [
    item({ id: "w1", first_name: "Mark", last_name: "Salek", company_domain: "cleannetusa.com" }),
    item({ id: "w2", first_name: "Ghost", last_name: "Person", company_domain: "cleannetusa.com" }),
    item({ id: "w3", first_name: "X", last_name: "Y", company_domain: "uncrawled.com" }),
  ];
  const ds = [
    {
      domain: "cleannetusa.com",
      emails: ["info@cleannetusa.com", "sales@cleannetusa.com"],
      leadsEnrichment: [{ firstName: "Mark", lastName: "Salek", email: "msalek@cleannetusa.com", emailVerificationStatus: "valid" }],
    },
  ];
  const r = waterfallVdrmotaProvider.parseItems(ds, items);
  eq(r.get("w1")?.status, "found", "vdrmota person matched in leadsEnrichment");
  eq(r.get("w1")?.email, "msalek@cleannetusa.com", "vdrmota email");
  eq(
    (r.get("w1")?.extra as { waterfall_status?: string })?.waterfall_status,
    "valid",
    "vdrmota raw verification kept as provenance (not a verdict)",
  );
  assert(Array.isArray((r.get("w1")?.extra as { company_emails?: unknown[] })?.company_emails), "vdrmota company_emails captured");
  eq(r.get("w2")?.status, "not_found", "vdrmota person not in leads → not_found");
  eq(r.get("w3")?.status, "not_found", "vdrmota domain not crawled → not_found");
}

// ---------------- waterfall bovi ----------------
console.log("waterfallBoviProvider.parseItems");
{
  const items = [
    item({ id: "b1", first_name: "Mark", last_name: "Salek", company_domain: "cleannetusa.com" }),
    item({ id: "b2", first_name: "Jane", last_name: "Doe", company_domain: "example.com" }),
  ];
  const ds = [
    { firstName: "Mark", lastName: "Salek", domain: "cleannetusa.com", email: "msalek@cleannetusa.com", status: "verified", confidence: 0.92 },
    { firstName: "Jane", lastName: "Doe", domain: "example.com", email: "", status: "no_mx" },
  ];
  const r = waterfallBoviProvider.parseItems(ds, items);
  eq(r.get("b1")?.status, "found", "bovi echoed-key match");
  eq(
    (r.get("b1")?.extra as { waterfall_status?: string })?.waterfall_status,
    "verified",
    "bovi raw status kept as provenance (not a verdict)",
  );
  eq(r.get("b1")?.confidence, 92, "bovi confidence scaled to 0-100");
  eq(r.get("b2")?.status, "not_found", "bovi empty email → not_found");
}

// Email verification is Million Verifier's job now — no Apify verify provider.

// ---------------- activity harvestapi ----------------
console.log("activityProvider.parseItems");
{
  const items = [
    item({ id: "act1", linkedin_url: "https://www.linkedin.com/in/ACwAAABBB", profile_id: "ACwAAABBB" }),
    item({ id: "act2", linkedin_url: "https://www.linkedin.com/in/ACwAAAZZZ", profile_id: "ACwAAAZZZ" }),
  ];
  const recent = new Date(Date.now() - 3 * 86400000).toISOString();
  const older = new Date(Date.now() - 40 * 86400000).toISOString();
  const ds = [
    { author: { linkedinUrl: "https://www.linkedin.com/in/ACwAAABBB" }, postedAt: { date: recent }, content: "hi" },
    { author: { linkedinUrl: "https://www.linkedin.com/in/ACwAAABBB" }, postedAt: { date: older }, content: "old" },
  ];
  const r = activityProvider.parseItems(ds, items);
  eq(r.get("act1")?.status, "found", "activity: author matched by URN id");
  const extra = (r.get("act1")?.extra ?? {}) as { last_posted_at?: string; recent_post_count?: number; recent_30d_count?: number };
  eq(extra.last_posted_at, recent, "activity: last_posted_at = newest post");
  eq(extra.recent_post_count, 2, "activity: recent_post_count counts sampled posts");
  eq(extra.recent_30d_count, 1, "activity: 30d count excludes the 40-day-old post");
  eq(r.get("act2")?.status, "not_found", "activity: no posts → not_found");
}

// ---------------- ApifyClient (monkeypatched fetch) ----------------
console.log("ApifyClient");
async function clientTests() {
  const realFetch = globalThis.fetch;
  try {
    // bearer header + dataset pagination (two pages of 2, then short page)
    {
      const seen: string[] = [];
      let call = 0;
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        seen.push(String(init?.headers && (init.headers as Record<string, string>)["Authorization"]));
        call++;
        const u = new URL(String(url));
        const offset = Number(u.searchParams.get("offset") ?? 0);
        const page = offset === 0 ? [{ n: 1 }, { n: 2 }] : offset === 2 ? [{ n: 3 }] : [];
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: { "x-apify-pagination-total": "3" },
        });
      }) as unknown as typeof fetch;
      const c = new ApifyClient("tok123");
      const all = await c.getAllDatasetItems("ds1", { pageSize: 2 });
      eq(all.length, 3, "pagination collected all items");
      assert(seen.every((h) => h === "Bearer tok123"), "bearer token on every request");
    }
    // 429 then 200 on a GET → retried
    {
      let n = 0;
      globalThis.fetch = (async () => {
        n++;
        if (n === 1) return new Response("rate", { status: 429 });
        return new Response(JSON.stringify({ data: { username: "acme" } }), { status: 200 });
      }) as unknown as typeof fetch;
      const c = new ApifyClient("t");
      const me = await c.getMe();
      eq(me.username, "acme", "GET retried after 429");
      eq(n, 2, "exactly one retry after 429");
    }
    // POST network error → NOT retried (run start must not replay)
    {
      let n = 0;
      globalThis.fetch = (async () => {
        n++;
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch;
      const c = new ApifyClient("t");
      let threw = false;
      try {
        await c.startActorRun("user~actor", { x: 1 }, { waitForFinishSec: 5 });
      } catch {
        threw = true;
      }
      assert(threw, "startActorRun surfaces the network error");
      eq(n, 1, "startActorRun did NOT retry the POST");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------- optional live smoke ----------------
async function liveSmoke() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    console.log("\n(live smoke skipped — set APIFY_API_TOKEN to run it)");
    return;
  }
  console.log("\nLIVE smoke (APIFY_API_TOKEN present)");
  const c = new ApifyClient(token);
  const me = await c.getMe();
  console.log("  getMe →", me.username);
  // Company batch — the deterministic one.
  const run = await c.startActorRun(
    "harvestapi~linkedin-company",
    { companies: ["https://www.linkedin.com/company/19178324"] },
    { waitForFinishSec: 60, timeoutSec: 300 },
  );
  console.log("  company run:", run.id, run.status);
  let final = run;
  for (let i = 0; i < 30 && !["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"].includes(final.status); i++) {
    await new Promise((r) => setTimeout(r, 4000));
    final = await c.getRun(run.id);
  }
  const items = await c.getAllDatasetItems(final.defaultDatasetId);
  console.log("  company items:", JSON.stringify(items).slice(0, 800));
}

(async () => {
  await clientTests();
  await liveSmoke();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
})();
