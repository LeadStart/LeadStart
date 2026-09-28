#!/usr/bin/env node
/**
 * Unit tests for the Workspace provisioning state machine: the pure reducer
 * (provisioning.ts) and the runner (provisioning-runner.ts) driven with fully
 * stubbed Google / registrar / Gmail / DNS / DB dependencies. No network, no DB.
 * Run: npx tsx scripts/test-provisioning.ts
 */
import {
  MAX_INBOXES_PER_DOMAIN,
  initProvisioningState,
  initAddInboxesState,
  inboxSetupEligibility,
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

// A finished first-setup run (every step done), as on tubeforseo.com.
function finishedRun(extra: Partial<ReturnType<typeof initProvisioningState>> = {}) {
  let s = initProvisioningState({
    now: T0,
    domain: "tryacme.com",
    users: [{ local_part: "jane", display_name: "Jane Doe" }],
    licensing: null,
    dmarcRua: "dmarc@leadstart.io",
  });
  for (const id of PROVISIONING_STEP_ORDER) s = markStep(s, id, { status: "done", attempts: 1 }, T0);
  return { ...s, site_verification_token: "google-site-verification=PREV", completed_at: T0, ...extra };
}

console.log("inboxSetupEligibility");
{
  const gmail = { tier: "gmail" as const, provisioning: null };
  const v = (d: Parameters<typeof inboxSetupEligibility>[0]) => inboxSetupEligibility(d);
  const mode = (d: Parameters<typeof inboxSetupEligibility>[0]) => {
    const r = v(d);
    return r.ok ? r.mode : "refused";
  };
  eq(mode({ ...gmail, lifecycle_status: "provisioning" }), "setup", "tracked, never set up → first setup");
  eq(mode({ ...gmail, lifecycle_status: "active" }), "add_inboxes", "backfilled active domain (no run) → add inboxes");
  eq(mode({ ...gmail, lifecycle_status: "warming" }), "add_inboxes", "backfilled warming domain (no run) → add inboxes");
  eq(
    mode({ ...gmail, lifecycle_status: "warming", provisioning: finishedRun() }),
    "add_inboxes",
    "finished setup run on a warming domain → add inboxes (the emptied TuBe case)",
  );
  const parkedAtDkim = { ...markStep(finishedRun(), "dkim", { status: "in_progress" }, T0), completed_at: null };
  eq(
    mode({ ...gmail, lifecycle_status: "provisioning", provisioning: parkedAtDkim }),
    "add_inboxes",
    "run parked at DKIM → add inboxes (users/mailboxes already done)",
  );
  const midRun = { ...markStep(finishedRun(), "mailboxes", { status: "in_progress" }, T0), completed_at: null };
  const r1 = v({ ...gmail, lifecycle_status: "provisioning", provisioning: midRun });
  eq(r1.ok, false, "run still registering mailboxes → refused (never clobber a live run)");
  ok(!r1.ok && r1.reason.includes("Register mailboxes") && r1.reason.includes("still running"), "reason names the running step", r1);
  const failedUsers = markStep(finishedRun(), "users", { status: "failed" }, T0);
  const r2 = v({ ...gmail, lifecycle_status: "provisioning", provisioning: failedUsers });
  eq(r2.ok, false, "run halted on a failed step → refused");
  ok(!r2.ok && r2.reason.includes("Create inboxes") && r2.reason.includes("Check now"), "reason points at Check now", r2);
  const failedDomain = markStep(finishedRun(), "workspace_domain", { status: "failed" }, T0);
  eq(v({ ...gmail, lifecycle_status: "provisioning", provisioning: failedDomain }).ok, false, "domain-level failure → refused");
  for (const lc of ["tired", "resting", "burned", "retired"] as const) {
    eq(v({ ...gmail, lifecycle_status: lc }).ok, false, `${lc} domain → refused`);
  }
  eq(v({ tier: "smtp", lifecycle_status: "active", provisioning: null }).ok, false, "SMTP-tier domain → refused");

  // Hard cap: 3 inboxes per domain, counted from the domain's existing inboxes.
  eq(MAX_INBOXES_PER_DOMAIN, 3, "hard cap is 3 inboxes per domain");
  const finishedWarming = { ...gmail, lifecycle_status: "warming" as const, provisioning: finishedRun() };
  eq(inboxSetupEligibility(finishedWarming, 2).ok, true, "2 inboxes → room for 1 more");
  const full = inboxSetupEligibility(finishedWarming, 3);
  eq(full.ok, false, "3 inboxes → full, refused");
  ok(!full.ok && full.reason.includes("at most 3") && full.reason.includes("another domain"), "full reason names the cap and the fix", full);
  eq(inboxSetupEligibility({ ...gmail, lifecycle_status: "active" }, 4).ok, false, "over the cap (legacy 4) → refused");
  eq(
    inboxSetupEligibility({ ...gmail, lifecycle_status: "provisioning" }, 3).ok,
    false,
    "a never-set-up domain already holding 3 connected inboxes → refused",
  );
  const runningFull = inboxSetupEligibility({ ...gmail, lifecycle_status: "provisioning", provisioning: midRun }, 3);
  ok(!runningFull.ok && runningFull.reason.includes("still running"), "a running setup reports that first, not the cap", runningFull);
}

console.log("initAddInboxesState");
{
  const prev = finishedRun();
  const s = initAddInboxesState({
    now: T0,
    domain: "tryacme.com",
    users: [{ local_part: "sam", display_name: "Sam Lee", given_name: "Sam", family_name: "Lee" }],
    licensing: null,
    dmarcRua: null,
    previous: prev,
    domainVerified: true,
    watchDkim: false,
  });
  eq(s.kind, "add_inboxes", "kind marks the run");
  eq(s.steps.dns_records.status, "skipped", "DNS is never rewritten");
  eq(s.steps.workspace_domain.status, "done", "domain already on the Workspace (checked live by the route)");
  eq(s.steps.site_verification_token.status, "done", "verification token pre-completed when verified");
  eq(s.steps.site_verification.status, "done", "verification pre-completed when verified");
  eq(s.steps.dkim.status, "skipped", "a domain that already sends skips DKIM");
  eq(firstIncompleteStep(s), "users", "the run starts at Create inboxes");
  ok(PROVISIONING_STEP_ORDER.every((id) => s.steps[id].attempts === 0), "pre-completed steps keep attempts at 0");
  eq(s.site_verification_token, "google-site-verification=PREV", "verification token carried forward for the DNS panel");
  eq(s.dmarc_rua, "dmarc@leadstart.io", "DMARC rua carried forward");
  eq(s.users.length, 1, "only the new inbox is in the run");
  eq(s.users[0].email, "sam@tryacme.com", "new user email derived");
  eq(s.users[0].created, false, "new user not created yet");
  eq(s.completed_at, null, "not complete at init");

  const unverified = initAddInboxesState({
    now: T0,
    domain: "tryacme.com",
    users: [{ local_part: "sam", display_name: "Sam Lee" }],
    licensing: null,
    dmarcRua: null,
    previous: null,
    domainVerified: false,
    watchDkim: true,
  });
  eq(firstIncompleteStep(unverified), "site_verification_token", "unverified on the Workspace → verification still runs");
  eq(unverified.steps.dkim.status, "pending", "a domain still in provisioning keeps watching DKIM");
}

// ── Runner (stubbed deps) ────────────────────────────────────────────────────
// A chainable Supabase-admin mock. update-chains resolve via `then`; a
// native_mailboxes insert().select().single() returns a fresh id. Every
// update() payload is recorded per table so tests can assert what was written.
function makeAdmin(updates: { table: string; payload: unknown }[] = []) {
  let seq = 0;
  const api: Record<string, unknown> = {};
  const chain = (table: string) => {
    const node: Record<string, unknown> = {
      update: (payload: unknown) => {
        updates.push({ table, payload });
        return node;
      },
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

function domainWith(state: unknown, lifecycle_status = "provisioning") {
  return { id: "dom-1", organization_id: "org-1", domain: "tryacme.com", lifecycle_status, provisioning: state };
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

// Counts every call that would touch the domain itself (Workspace membership,
// verification, DNS, DKIM probe), so add-inboxes runs can prove they don't.
function countingDeps(dkim: "pass" | "fail") {
  const calls = { insertDomain: 0, getDnsToken: 0, verifyDomain: 0, upsertDns: 0, checkAuth: 0 };
  const updates: { table: string; payload: unknown }[] = [];
  const deps = happyDeps({
    insertDomain: async () => {
      calls.insertDomain++;
      return { created: false, verified: true };
    },
    checkAuth: async () => {
      calls.checkAuth++;
      return {
        domain: "tryacme.com",
        spf: { status: "pass", detail: "" },
        dkim: { status: dkim, detail: "" },
        dmarc: { status: "pass", detail: "" },
      };
    },
    registrar: {
      id: "porkbun",
      upsertDnsRecords: async () => {
        calls.upsertDns++;
      },
      checkAvailability: async () => ({}),
      registerDomain: async () => ({}),
      getDnsRecords: async () => [],
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = deps.workspace as any;
  ws.siteVerification.getDnsToken = async () => {
    calls.getDnsToken++;
    return "google-site-verification=NEW";
  };
  ws.siteVerification.verifyDomain = async () => {
    calls.verifyDomain++;
    return { verified: true, detail: "" };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (deps as any).admin = makeAdmin(updates);
  return { deps, calls, updates };
}
const lifecycleWrites = (updates: { table: string; payload: unknown }[]) =>
  updates.filter((u) => u.table === "sending_domains" && JSON.stringify(u.payload).includes("lifecycle_status")).length;

console.log("advanceProvisioning, add-inboxes run on a domain that already sends");
{
  const { deps, calls, updates } = countingDeps("pass");
  const state = initAddInboxesState({
    now: T0,
    domain: "tryacme.com",
    users: [{ local_part: "sam", display_name: "Sam Lee", given_name: "Sam", family_name: "Lee" }],
    licensing: null,
    dmarcRua: null,
    previous: finishedRun(),
    domainVerified: true,
    watchDkim: false,
  });
  const domain = { ...domainWith(state, "warming"), registrar: "porkbun" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await advanceProvisioning(deps as any, domain as any);
  eq(calls.insertDomain, 0, "never re-adds the domain to the Workspace");
  eq(calls.getDnsToken + calls.verifyDomain, 0, "never re-verifies the domain");
  eq(calls.upsertDns, 0, "never touches DNS");
  eq(calls.checkAuth, 0, "no DKIM probe (step skipped)");
  eq(res.advanced.join(","), "users,licenses,mailboxes", "works only the inbox steps");
  eq(res.state.steps.users.status, "done", "new user created");
  eq(res.state.steps.mailboxes.status, "done", "new mailbox registered");
  eq(res.state.users[0].mailbox_id, "mbx-1", "mailbox id recorded on the new user");
  eq(res.revealed_passwords.length, 1, "one-time password revealed for the new inbox");
  eq(res.revealed_passwords[0].email, "sam@tryacme.com", "password tied to the new inbox");
  eq(res.became_warming, false, "no lifecycle flip on a domain that already sends");
  eq(lifecycleWrites(updates), 0, "lifecycle never written");
  ok(res.state.completed_at != null, "run completes, so the cron stops selecting it");
}

console.log("advanceProvisioning, add-inboxes on a domain still waiting on DKIM");
{
  const state = initAddInboxesState({
    now: T0,
    domain: "tryacme.com",
    users: [{ local_part: "sam", display_name: "Sam Lee" }],
    licensing: null,
    dmarcRua: null,
    previous: null,
    domainVerified: true,
    watchDkim: true,
  });
  const waiting = countingDeps("fail");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r1 = await advanceProvisioning(waiting.deps as any, domainWith(state) as any);
  eq(r1.state.steps.mailboxes.status, "done", "inbox registered before DKIM");
  eq(r1.state.steps.dkim.status, "in_progress", "DKIM still awaited");
  eq(r1.state.completed_at, null, "run stays open so the cron keeps watching DKIM");
  eq(r1.became_warming, false, "no flip while DKIM is missing");

  const landed = countingDeps("pass");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r2 = await advanceProvisioning(landed.deps as any, domainWith(r1.state) as any);
  eq(r2.state.steps.dkim.status, "done", "DKIM detected");
  eq(r2.became_warming, true, "provisioning domain flips to warming when DKIM lands");
  eq(lifecycleWrites(landed.updates), 1, "exactly one guarded lifecycle write");
  eq(r2.revealed_passwords.length, 0, "no password re-revealed on the follow-up tick");
}

console.log("advanceProvisioning, DKIM step on a domain that already sends never claims a flip");
{
  const { deps, updates } = countingDeps("pass");
  const state = markStep(
    { ...finishedRun(), completed_at: null },
    "dkim",
    { status: "pending" },
    T0,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await advanceProvisioning(deps as any, domainWith(state, "active") as any);
  eq(res.state.steps.dkim.status, "done", "DKIM step completes");
  eq(res.became_warming, false, "active domain: became_warming is false");
  eq(lifecycleWrites(updates), 0, "active domain: lifecycle never written");
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
