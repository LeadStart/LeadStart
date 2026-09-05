#!/usr/bin/env node
/**
 * Unit tests for the Workspace provisioning state machine: the pure reducer
 * (provisioning.ts) and the runner (provisioning-runner.ts) driven with fully
 * stubbed Google / registrar / Gmail / DNS / DB dependencies. No network, no DB.
 * Run: npx tsx scripts/test-provisioning.ts
 */
import {
  initProvisioningState,
  markStep,
  firstIncompleteStep,
  isCompleteStatus,
  isTerminalStatus,
  allStepsComplete,
  splitDisplayName,
  PROVISIONING_STEP_ORDER,
} from "../src/lib/deliverability/provisioning.ts";
import { advanceProvisioning } from "../src/lib/deliverability/provisioning-runner.ts";
import { GooglePermanentError } from "../src/lib/google/auth.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}
function ok(cond: boolean, msg: string, extra?: unknown) {
  eq(!!cond, true, extra !== undefined ? `${msg}: ${JSON.stringify(extra)}` : msg);
}

async function main() {
// ── Pure reducer ─────────────────────────────────────────────────────────────
console.log("initProvisioningState");
const T0 = "2026-08-27T00:00:00.000Z";
const init = initProvisioningState({
  now: T0,
  domain: "tryacme.com",
  users: [
    { local_part: "jane", display_name: "Jane Doe" },
    { local_part: "info", display_name: "Info" },
  ],
  licensing: null,
  dmarcRua: "dmarc@leadstart.io",
});
eq(Object.keys(init.steps).length, 8, "8 steps");
eq(PROVISIONING_STEP_ORDER.every((id) => init.steps[id].status === "pending"), true, "all steps start pending");
eq(init.users[0].email, "jane@tryacme.com", "user email derived from local_part@domain");
eq(init.users[1].email, "info@tryacme.com", "second user email derived");
eq(init.completed_at, null, "not complete at init");
eq(init.version, 1, "version 1");

console.log("splitDisplayName");
eq(splitDisplayName("Jane Doe").givenName, "Jane", "given name");
eq(splitDisplayName("Jane Doe").familyName, "Doe", "family name");
eq(splitDisplayName("Cher").familyName, "-", "single token → placeholder family");
eq(splitDisplayName("Mary Jane Watson").givenName, "Mary Jane", "split on the LAST space");

console.log("markStep + ordering");
{
  const s1 = markStep(init, "dns_records", { status: "done" }, "2026-08-27T00:01:00.000Z");
  eq(s1.steps.dns_records.status, "done", "marks the step");
  eq(init.steps.dns_records.status, "pending", "original state is untouched (immutable)");
  eq(s1.updated_at, "2026-08-27T00:01:00.000Z", "updated_at bumped (the CAS token)");
  eq(firstIncompleteStep(s1), "workspace_domain", "first incomplete advances past a done step");
  eq(isCompleteStatus("skipped"), true, "skipped counts as complete");
  eq(isCompleteStatus("failed"), false, "failed does NOT count as complete");
  eq(isTerminalStatus("failed"), true, "failed is terminal");
  eq(allStepsComplete(init), false, "fresh state not complete");
}

// ── Runner (stubbed deps) ────────────────────────────────────────────────────
// A chainable Supabase-admin mock. update-chains resolve via `then`; a
// native_mailboxes insert().select().single() returns a fresh id.
function makeAdmin() {
  let seq = 0;
  const api: Record<string, unknown> = {};
  const chain = (table: string) => {
    const node: Record<string, unknown> = {
      update: () => node,
      insert: () => node,
      select: () => node,
      eq: () => node,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => {
        if (table === "native_mailboxes") {
          seq++;
          return Promise.resolve({ data: { id: `mbx-${seq}` }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    };
    return node;
  };
  api.from = (table: string) => chain(table);
  return api;
}

function happyDeps(over: Record<string, unknown> = {}) {
  const insertUser = (over.insertUser as (() => Promise<{ created: boolean }>)) ?? (async () => ({ created: true }));
  return {
    admin: makeAdmin(),
    registrar: over.registrar !== undefined
      ? over.registrar
      : { id: "porkbun", upsertDnsRecords: async () => {}, checkAvailability: async () => ({}), registerDomain: async () => ({}), getDnsRecords: async () => [] },
    workspace: {
      sa: {},
      adminEmail: "admin@tryacme.com",
      directory: {
        insertDomain: (over.insertDomain as unknown) ?? (async () => ({ created: true, verified: false })),
        getDomain: async () => ({ exists: true, verified: true }),
        insertUser,
        getUser: async () => ({ exists: true, suspended: false }),
      },
      siteVerification: {
        getDnsToken: async () => "google-site-verification=TESTTOKEN",
        verifyDomain: async () => ({ verified: true, detail: "Verified." }),
      },
      licensing: { assignLicense: async () => ({ assigned: true, already: false }) },
      licensingDefaults: null,
    },
    gmail: { getProfile: async () => ({ emailAddress: "x@tryacme.com" }) },
    checkAuth: (over.checkAuth as unknown) ?? (async () => ({
      domain: "tryacme.com",
      spf: { status: "pass", detail: "" },
      dkim: { status: "pass", detail: "" },
      dmarc: { status: "pass", detail: "" },
    })),
    now: () => "2026-08-27T01:00:00.000Z",
  };
}

function domainWith(state: unknown) {
  return { id: "dom-1", organization_id: "org-1", domain: "tryacme.com", provisioning: state };
}

console.log("advanceProvisioning, happy path");
{
  const state = initProvisioningState({
    now: T0,
    domain: "tryacme.com",
    users: [{ local_part: "jane", display_name: "Jane Doe" }],
    licensing: null,
    dmarcRua: null,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await advanceProvisioning(happyDeps() as any, domainWith(state) as any);
  eq(res.state.steps.dns_records.status, "done", "dns written");
  eq(res.state.steps.workspace_domain.status, "done", "domain added");
  eq(res.state.steps.site_verification.status, "done", "verified");
  eq(res.state.steps.users.status, "done", "user created");
  eq(res.state.steps.licenses.status, "skipped", "no SKU → licenses skipped");
  eq(res.state.steps.mailboxes.status, "done", "mailbox row created");
  eq(res.state.steps.dkim.status, "done", "dkim detected");
  eq(res.became_warming, true, "flips to warming when dkim lands");
  ok(res.state.completed_at != null, "completed_at stamped");
  eq(res.state.users[0].mailbox_id, "mbx-1", "mailbox id recorded on the user");
  eq(res.revealed_passwords.length, 1, "one password revealed");
  eq(res.revealed_passwords[0].email, "jane@tryacme.com", "password tied to the user email");
  const pw = res.revealed_passwords[0].password;
  ok(pw.length >= 20, "password is long", pw.length);
  ok(!JSON.stringify(res.state).includes(pw), "password is NEVER serialized into the stored state");
}

console.log("advanceProvisioning, manual registrar skips DNS write steps");
{
  const state = initProvisioningState({
    now: T0, domain: "tryacme.com",
    users: [{ local_part: "jane", display_name: "Jane Doe" }],
    licensing: null, dmarcRua: null,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await advanceProvisioning(happyDeps({ registrar: null }) as any, domainWith(state) as any);
  eq(res.state.steps.dns_records.status, "skipped", "manual registrar → dns_records skipped");
  eq(res.state.site_verification_token, "google-site-verification=TESTTOKEN", "token still obtained for copy-paste");
  eq(res.state.steps.dkim.status, "done", "still completes end-to-end");
}

console.log("advanceProvisioning, non-manual registrar with no API key fails DNS with guidance");
{
  const state = initProvisioningState({
    now: T0, domain: "tryacme.com",
    users: [{ local_part: "jane", display_name: "Jane Doe" }],
    licensing: null, dmarcRua: null,
  });
  // registrar column says porkbun, but no provider could be built (key missing).
  const domain = { id: "dom-1", organization_id: "org-1", domain: "tryacme.com", registrar: "porkbun", provisioning: state };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await advanceProvisioning(happyDeps({ registrar: null }) as any, domain as any);
  eq(res.state.steps.dns_records.status, "failed", "porkbun + no key → dns_records FAILED (not silently skipped)");
  eq(res.state.steps.workspace_domain.status, "pending", "flow halts at DNS; downstream steps untouched");
  const e = res.state.steps.dns_records.last_error ?? "";
  ok(e.includes("Porkbun API key"), "message names the missing Porkbun API key", e);
  ok(e.includes("Retry DNS"), "message tells the owner to Retry DNS", e);
}

console.log("advanceProvisioning, unverified domain shows an actionable hint, not Google's raw 400");
{
  const state = initProvisioningState({
    now: T0, domain: "tryacme.com",
    users: [{ local_part: "jane", display_name: "Jane Doe" }],
    licensing: null, dmarcRua: null,
  });
  const deps = happyDeps();
  // On a connected registrar DNS/token succeed, but Google reports not-verified
  // (TXT not visible yet): the common wait state that used to surface a raw 400.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (deps.workspace.siteVerification as any).verifyDomain = async () => ({
    verified: false,
    detail: "Site Verification 400: The necessary verification token could not be found on your site.",
  });
  const domain = { id: "dom-1", organization_id: "org-1", domain: "tryacme.com", registrar: "porkbun", provisioning: state };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await advanceProvisioning(deps as any, domain as any);
  eq(res.state.steps.site_verification.status, "in_progress", "unverified → in_progress (retryable)");
  const e = res.state.steps.site_verification.last_error ?? "";
  ok(!e.includes("400"), "Google's raw 400 is no longer surfaced", e);
  ok(e.includes("google-site-verification") || e.includes("DNS records"), "hint names what to check", e);
}

console.log("advanceProvisioning, licensing configured assigns then completes");
{
  const state = initProvisioningState({
    now: T0, domain: "tryacme.com",
    users: [{ local_part: "jane", display_name: "Jane Doe" }],
    licensing: { product_id: "Google-Apps", sku_id: "1010020028" }, dmarcRua: null,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await advanceProvisioning(happyDeps() as any, domainWith(state) as any);
  eq(res.state.steps.licenses.status, "done", "SKU configured → licenses assigned (done, not skipped)");
  eq(res.state.users[0].licensed, true, "user marked licensed");
}

console.log("advanceProvisioning, permanent error halts and stamps completed_at");
{
  const state = initProvisioningState({
    now: T0, domain: "tryacme.com",
    users: [{ local_part: "jane", display_name: "Jane Doe" }],
    licensing: null, dmarcRua: null,
  });
  const deps = happyDeps({
    insertDomain: async () => {
      throw new GooglePermanentError("Directory 400: domain belongs to another account", 400);
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await advanceProvisioning(deps as any, domainWith(state) as any);
  eq(res.state.steps.dns_records.status, "done", "dns still done");
  eq(res.state.steps.workspace_domain.status, "failed", "permanent error → step failed");
  eq(res.state.steps.users.status, "pending", "downstream steps untouched (blocked)");
  eq(res.became_warming, false, "no warming flip on failure");
  ok(res.state.completed_at != null, "completed_at stamped so the cron stops retrying (Check-now can reset)");
  ok((res.state.last_error ?? "").includes("another account"), "surfaces the failure message");
}

console.log("advanceProvisioning, 409-resume reveals no password; re-run is a no-op");
{
  const state = initProvisioningState({
    now: T0, domain: "tryacme.com",
    users: [{ local_part: "jane", display_name: "Jane Doe" }],
    licensing: null, dmarcRua: null,
  });
  const deps = happyDeps({ insertUser: async () => ({ created: false }) }); // already exists
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await advanceProvisioning(deps as any, domainWith(state) as any);
  eq(res.state.steps.users.status, "done", "user step still completes on a 409-resume");
  eq(res.revealed_passwords.length, 0, "no password revealed for an already-existing user");

  // Re-run against the completed state → nothing to do.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const again = await advanceProvisioning(happyDeps() as any, domainWith(res.state) as any);
  eq(again.advanced.length, 0, "second run advances nothing (idempotent)");
  eq(again.revealed_passwords.length, 0, "second run reveals nothing");
  eq(again.became_warming, false, "second run does not re-flip");
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
