#!/usr/bin/env node
/**
 * Drives the REAL client-import POST handler
 * (src/app/api/campaigns/[id]/client-import/route.ts) against an in-memory
 * database, to prove that a list import never modifies a contact that is
 * already in a sequence:
 *   - enrolled in this campaign (any status): untouched, counted already_enrolled
 *   - active or paused in another campaign: untouched AND not enrolled here,
 *     counted skipped_other_campaign
 *   - everyone else (no enrollment, or only finished/failed elsewhere): custom
 *     fields merged, campaign_id set, enrolled at step 0
 *   - the enrollment lookup fails closed, before any write
 *   - re-uploading the same file changes no contact
 *
 * scripts/tsconfig.client-import-harness.json swaps the Supabase clients and
 * the owner-alert queue for scripts/_stubs/fake-supabase.ts. No network, no
 * database: nothing here can reach the live project.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.client-import-harness.json scripts/test-client-import-guard.ts
 */
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyTokens, buildTokenMap } from "../src/lib/native/tokens.ts";
import { fakeState, resetFake } from "./_stubs/fake-supabase.ts";

// If the module swap ever failed, a real client would get an unreachable URL
// and no service key, so it could not reach the live project either.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "harness";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

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
function ok(cond: boolean, msg: string, extra?: unknown) {
  eq(!!cond, true, extra !== undefined ? `${msg}: ${JSON.stringify(extra)}` : msg);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const ORG = "org-harness";
const DAVID = "client-david";
const OTHER_CLIENT = "client-other";
const THIS = "camp-this";
const OTHER = "camp-other";
const DONE = "camp-done";
const STEP0_SUBJECT = "Congrats on closing {{PropertyAddress}}";

const OWNER = { id: "user-owner", email: "owner@harness.test", app_metadata: { role: "owner", organization_id: ORG } };
const CLIENT_USER = { id: "user-client", email: "david@harness.test", app_metadata: { role: "client" } };

function campaign(id: string, status: string): Row {
  return {
    id,
    organization_id: ORG,
    client_id: DAVID,
    name: `Harness ${id}`,
    status,
    source_channel: "native_email",
    csv_column_mapping: null,
    flow_graph: null,
    variables: [],
  };
}

function contact(key: string, over: Row = {}): Row {
  return {
    id: `ct-${key}`,
    organization_id: ORG,
    client_id: DAVID,
    campaign_id: null,
    email: `${key}@agents.test`,
    first_name: key.toUpperCase(),
    status: "active",
    email_verification_status: null,
    custom_fields: { PropertyAddress: `OLD ${key}`, Price: "100" },
    tags: [],
    source: "harness",
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    ...over,
  };
}

function enrollment(key: string, campaignId: string, status: string, step: number, sent: boolean): Row {
  return {
    id: `enr-${key}-${campaignId}`,
    campaign_id: campaignId,
    contact_id: `ct-${key}`,
    current_step_index: step,
    status,
    last_action_at: sent ? "2026-09-30T15:00:00.000Z" : null,
    started_at: "2026-09-24T00:00:00.000Z",
  };
}

function fixtures(): Record<string, Row[]> {
  return {
    campaigns: [campaign(THIS, "active"), campaign(OTHER, "active"), campaign(DONE, "completed")],
    campaign_steps: [
      { campaign_id: THIS, step_index: 0, subject_template: STEP0_SUBJECT, body_template: "Hi {{first_name}}" },
      { campaign_id: THIS, step_index: 1, subject_template: null, body_template: "Following up on {{PropertyAddress}}" },
    ],
    clients: [
      { id: DAVID, name: "David (harness)" },
      { id: OTHER_CLIENT, name: "Other (harness)" },
    ],
    client_users: [{ user_id: CLIENT_USER.id, client_id: DAVID }],
    dnc_entries: [{ organization_id: ORG, client_id: DAVID, email: "dnc@agents.test" }],
    contacts: [
      contact("a1", { campaign_id: THIS }), //                    mid-sequence here (step 1 sent)
      contact("a2", { campaign_id: THIS }), //                    finished here
      contact("a3", { campaign_id: THIS, status: "uploaded" }), // queued here, nothing sent yet
      contact("a4", { campaign_id: OTHER }), //                   finished here AND active elsewhere
      contact("b1", { campaign_id: OTHER }), //                   active in another campaign
      contact("b2", { campaign_id: OTHER }), //                   paused in another campaign
      contact("b3", { campaign_id: DONE }), //                    finished another campaign
      contact("b4", { campaign_id: OTHER }), //                   failed in another campaign
      contact("c1"), //                                           in no campaign
      contact("d1", { client_id: null }), //                      LeadStart's own CRM, in no campaign
      contact("d2", { client_id: null }), //                      LeadStart's own CRM, active elsewhere
      contact("e1", { client_id: OTHER_CLIENT }), //              another client's contact
      contact("f1", { status: "replied" }), //                    replied before
    ],
    campaign_enrollments: [
      enrollment("a1", THIS, "active", 1, true),
      enrollment("a2", THIS, "completed", 6, true),
      enrollment("a3", THIS, "active", 0, false),
      enrollment("a4", THIS, "completed", 6, true),
      enrollment("a4", OTHER, "active", 2, true),
      enrollment("b1", OTHER, "active", 2, true),
      enrollment("b2", OTHER, "paused", 1, true),
      enrollment("b3", DONE, "completed", 6, true),
      enrollment("b4", OTHER, "failed", 0, false),
      enrollment("d2", OTHER, "active", 1, true),
    ],
  };
}

const csvRow = (key: string): Row => ({
  email: `${key}@agents.test`,
  first_name: key.toUpperCase(),
  custom_fields: { PropertyAddress: `NEW ${key}` },
});

// Every existing contact again (a re-uploaded weekly list), two new people,
// one in-file duplicate, one DNC address, one invalid email.
const UPLOAD: Row[] = [
  ...["a1", "a2", "a3", "a4", "b1", "b2", "b3", "b4", "c1", "d1", "d2", "e1", "f1", "n1", "n2"].map(csvRow),
  csvRow("c1"),
  { email: "dnc@agents.test", custom_fields: { PropertyAddress: "NEW dnc" } },
  { email: "not-an-email", custom_fields: {} },
];
const UNTOUCHED = ["a1", "a2", "a3", "a4", "b1", "b2", "d2", "e1", "f1"];
const LINKED = ["b3", "b4", "c1", "d1"];

// ── Helpers ─────────────────────────────────────────────────────────────────

type PostHandler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: PostHandler;

async function upload(rows: Row[]): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new NextRequest(`http://localhost/app/api/campaigns/${THIS}/client-import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rows,
      column_mapping: { Email: "email", "Property Address": "custom:PropertyAddress" },
      filename: "harness.csv",
    }),
  });
  const res = await POST(req, { params: Promise.resolve({ id: THIS }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const tables = () => fakeState().tables;
const contactByKey = (key: string) => tables().contacts.find((c) => c.email === `${key}@agents.test`) as Row;
const enrollmentsOf = (contactId: unknown) => tables().campaign_enrollments.filter((e) => e.contact_id === contactId);
const field = (c: Row, k: string) => (c.custom_fields as Record<string, unknown>)[k];

// The "Re:" subject of a follow-up with no subject of its own, built the way
// the sender's fallback builds it (run-native-sequences/route.ts, linear path):
// step 0's subject re-rendered from the contact's CURRENT fields, through the
// same shared buildTokenMap + applyTokens. (No spintax in this subject.)
function reSubject(c: Row): string {
  const tokenContact = {
    first_name: (c.first_name as string | null) ?? null,
    last_name: null,
    company_name: null,
    title: null,
    intro_line: null,
    email: (c.email as string | null) ?? null,
    phone: null,
    custom_fields: c.custom_fields as Record<string, unknown> | null,
  };
  const base = applyTokens(STEP0_SUBJECT, buildTokenMap(tokenContact, "Molly", null), () => "").trim();
  return base.toLowerCase().startsWith("re:") ? base : `Re: ${base}`;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function main() {
  if ((createAdminClient() as unknown as { __fake?: boolean }).__fake !== true) {
    throw new Error("The Supabase module swap did not take: run with --tsconfig scripts/tsconfig.client-import-harness.json");
  }
  ({ POST } = (await import("../src/app/api/campaigns/[id]/client-import/route.ts")) as unknown as { POST: PostHandler });

  console.log("\n1. Owner uploads a list that repeats people already in sequences");
  resetFake(fixtures(), OWNER);
  const before = structuredClone(tables());
  eq(reSubject(contactByKey("a1")), "Re: Congrats on closing OLD a1", "a1 before: its first email named OLD a1");
  const r1 = await upload(UPLOAD);
  eq(r1.status, 200, "responds 200");
  eq(r1.body.inserted, 2, "inserted: n1, n2");
  eq(r1.body.linked, 4, "linked: b3, b4, c1, d1");
  eq(r1.body.adopted, 1, "adopted: d1");
  eq(r1.body.enrolled, 6, "enrolled: n1, n2, b3, b4, c1, d1");
  eq(r1.body.already_enrolled, 4, "already_enrolled: a1, a2, a3, a4");
  eq(r1.body.skipped_other_campaign, 3, "skipped_other_campaign: b1, b2, d2");
  eq(r1.body.skipped_existing_elsewhere, 1, "skipped_existing_elsewhere: e1");
  eq(r1.body.skipped_suppressed, 1, "skipped_suppressed: f1");
  eq(r1.body.skipped_dnc, 1, "skipped_dnc: dnc@");
  eq(r1.body.skipped_invalid_email, 1, "skipped_invalid_email: not-an-email");
  eq(r1.body.in_file_duplicates, 1, "in_file_duplicates: the second c1 row");

  eq(
    reSubject(contactByKey("a1")),
    "Re: Congrats on closing OLD a1",
    "a1 after: its next 'Re:' still names the property its first email named",
  );
  for (const k of UNTOUCHED) {
    const was = before.contacts.find((c) => c.id === `ct-${k}`);
    eq(contactByKey(k), was, `${k}: contact row unchanged (fields, campaign_id, client_id)`);
  }
  const updatedIds = new Set(
    fakeState().writes.filter((w) => w.table === "contacts" && w.op === "update").flatMap((w) => w.ids),
  );
  ok(UNTOUCHED.every((k) => !updatedIds.has(`ct-${k}`)), "no update statement touched any of them");

  for (const k of LINKED) {
    const c = contactByKey(k);
    eq(field(c, "PropertyAddress"), `NEW ${k}`, `${k}: the list's value is merged in`);
    eq(field(c, "Price"), "100", `${k}: its other fields are kept (merge, not replace)`);
    eq(c.campaign_id, THIS, `${k}: assigned to this campaign`);
  }
  eq(contactByKey("d1").client_id, DAVID, "d1: adopted into the campaign's client");
  eq(contactByKey("d2").client_id, null, "d2: not adopted, it is active in another campaign");
  for (const k of ["n1", "n2"]) {
    const c = contactByKey(k);
    ok(!!c && c.client_id === DAVID && c.campaign_id === THIS, `${k}: inserted under the client and this campaign`);
  }

  for (const e of before.campaign_enrollments) {
    eq(tables().campaign_enrollments.find((x) => x.id === e.id), e, `enrollment ${e.id}: unchanged`);
  }
  for (const k of ["b1", "b2", "d2"]) {
    eq(enrollmentsOf(`ct-${k}`).length, 1, `${k}: still in its other campaign only (no second sequence)`);
  }
  const expectedHere = ["a1", "a2", "a3", "a4", "b3", "b4", "c1", "d1", "n1", "n2"].map((k) => contactByKey(k).id).sort();
  const here = tables()
    .campaign_enrollments.filter((e) => e.campaign_id === THIS)
    .map((e) => e.contact_id)
    .sort();
  eq(here, expectedHere, "this campaign's enrollments: the four already here plus the six new ones");
  const fresh = tables().campaign_enrollments.filter(
    (e) => e.campaign_id === THIS && !before.campaign_enrollments.some((b) => b.id === e.id),
  );
  ok(
    fresh.length === 6 && fresh.every((e) => e.status === "active" && e.current_step_index === 0),
    "the six new enrollments start active at step 0",
  );

  eq(fakeState().alerts.length, 1, "one owner alert");
  const alert = fakeState().alerts[0] ?? {};
  ok(String(alert.subject).includes("added 6 contacts"), "the alert counts only contacts actually added", alert.subject);
  const ctx = (alert.context ?? {}) as Record<string, unknown>;
  eq(ctx.already_enrolled, 4, "alert context: already_enrolled");
  eq(ctx.skipped_other_campaign, 3, "alert context: skipped_other_campaign");

  console.log("\n2. Re-uploading the same file changes no contact");
  const afterFirst = structuredClone(tables());
  const r2 = await upload(UPLOAD);
  eq(r2.status, 200, "responds 200");
  eq(r2.body.inserted, 0, "inserted: none");
  eq(r2.body.linked, 0, "linked: none");
  eq(r2.body.enrolled, 0, "enrolled: none");
  eq(r2.body.already_enrolled, 10, "already_enrolled: a1-a4 plus the six enrolled by the first upload");
  eq(r2.body.skipped_other_campaign, 3, "skipped_other_campaign: b1, b2, d2");
  eq(tables().contacts, afterFirst.contacts, "every contact row unchanged");
  eq(tables().campaign_enrollments, afterFirst.campaign_enrollments, "every enrollment unchanged");

  console.log("\n3. The enrollment lookup fails: 503 before any write");
  resetFake(fixtures(), OWNER);
  const pristine = structuredClone(tables());
  fakeState().failOn.add("campaign_enrollments:select");
  const r3 = await upload(UPLOAD);
  eq(r3.status, 503, "responds 503");
  eq(fakeState().writes.length, 0, "no write of any kind");
  eq(tables(), pristine, "database unchanged");

  console.log("\n4. A list of only new people never runs the lookup");
  resetFake(fixtures(), OWNER);
  fakeState().failOn.add("campaign_enrollments:select"); // would 503 if the lookup ran
  const r4 = await upload(["n7", "n8"].map(csvRow));
  eq(r4.status, 200, "responds 200");
  eq(r4.body.inserted, 2, "inserted: n7, n8");
  eq(r4.body.enrolled, 2, "enrolled: n7, n8");

  console.log("\n5. A client's own portal upload follows the same rule");
  resetFake(fixtures(), CLIENT_USER);
  const r5 = await upload(["a1", "b1", "c1", "d1"].map(csvRow));
  eq(r5.status, 200, "responds 200");
  eq(r5.body.already_enrolled, 1, "a1: already in this campaign");
  eq(r5.body.skipped_other_campaign, 1, "b1: in another campaign");
  eq(r5.body.linked, 1, "c1: linked");
  eq(r5.body.skipped_existing_elsewhere, 1, "d1: LeadStart's own contact is never adopted by a client");
  eq(field(contactByKey("a1"), "PropertyAddress"), "OLD a1", "a1: fields unchanged");

  // The route's documented recovery path: contacts saved by a run whose
  // enrollment write failed carry campaign_id but no enrollment, so the rule
  // (keyed off enrollments, not campaign_id) must still pick them up.
  console.log("\n6. A failed enrollment write is recovered by re-uploading the same file");
  resetFake(fixtures(), OWNER);
  fakeState().failOn.add("campaign_enrollments:upsert");
  const r6a = await upload(["c1", "n1"].map(csvRow));
  eq(r6a.status, 500, "first attempt: 500 after the contacts were saved");
  eq(contactByKey("c1").campaign_id, THIS, "c1: assigned to this campaign by the failed run");
  eq(enrollmentsOf(contactByKey("c1").id).length, 0, "c1: but not enrolled");
  const r6b = await upload(["c1", "n1"].map(csvRow));
  eq(r6b.status, 200, "re-upload: responds 200");
  eq(r6b.body.enrolled, 2, "re-upload: enrolls c1 and n1");
  eq(r6b.body.already_enrolled, 0, "re-upload: neither counted as already in this campaign");

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
