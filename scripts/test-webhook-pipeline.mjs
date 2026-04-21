#!/usr/bin/env node
/**
 * Smoke test for the webhook routing plumbing (commit #6):
 *   1. correlateTag() — how lead_* events merge into existing rows or
 *      create placeholders when they arrive before reply_received.
 *   2. runReplyPipeline() — classification write-back + notify-or-skip
 *      decision branches.
 *
 * Uses an in-memory Supabase stub (no network, no real DB). Claude is
 * disabled for the pipeline test via an unset ANTHROPIC_API_KEY so the
 * run is deterministic; decide.ts falls back to the prefilter verdict.
 *
 * Usage:
 *   npx tsx scripts/test-webhook-pipeline.mjs
 */

import { readFileSync, existsSync } from "node:fs";

function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
loadEnvLocal();

// --- Harness ---
let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// --- Minimal in-memory Supabase stub ---------------------------------
// Supports the subset the modules we're testing actually use:
//   .from(table).select(cols).eq(col, val).maybeSingle()
//   .from(table).select(cols).eq(col, val).limit(n).single()
//   .from(table).insert(obj).select(cols).single()
//   .from(table).update(obj).eq(col, val)
//   .from(table).update(obj).eq(col, val).select(cols).maybeSingle()
//   .from(table).upsert(obj, opts).select(cols).single()
//
// Tables are arrays of row objects; we match by any column name in chained
// .eq() calls. .select() just passes the row through — tests assert on the
// stored state rather than what select returned.
function makeStub(initial = {}) {
  const tables = {
    lead_replies: [...(initial.lead_replies || [])],
    clients: [...(initial.clients || [])],
  };

  let nextId = 1;
  const genId = (prefix) => `${prefix}-stub-${String(nextId++).padStart(4, "0")}`;

  function query(tableName) {
    const rows = tables[tableName] || (tables[tableName] = []);
    const state = {
      filters: [],      // { col, val, op: 'eq' | 'is' | 'not' }
      updatePatch: null,
      insertPayload: null,
      upsertPayload: null,
      limitN: undefined,
    };

    const api = {
      select: () => api,
      eq(col, val) {
        state.filters.push({ col, val, op: "eq" });
        return api;
      },
      is(col, val) {
        state.filters.push({ col, val, op: "is" });
        return api;
      },
      limit(n) {
        state.limitN = n;
        return api;
      },
      update(patch) {
        state.updatePatch = patch;
        return api;
      },
      insert(payload) {
        state.insertPayload = payload;
        return api;
      },
      upsert(payload) {
        state.upsertPayload = payload;
        return api;
      },
      maybeSingle: async () => resolveRead(1),
      single: async () => resolveRead(1),
      // Make the builder awaitable directly (matches Supabase's
      // PostgrestFilterBuilder — `.update().eq()` resolves to {data,error}
      // without needing `.single()` afterwards).
      then(onFulfilled, onRejected) {
        return resolveRead(0).then(onFulfilled, onRejected);
      },
    };

    function matches(row) {
      return state.filters.every(({ col, val, op }) => {
        const v = row[col];
        if (op === "is") return v === val;
        return v === val;
      });
    }

    async function resolveRead(_expectedCount) {
      // Resolution order: update > insert > upsert > select
      if (state.updatePatch) {
        const idx = rows.findIndex(matches);
        if (idx === -1) return { data: null, error: null };
        rows[idx] = { ...rows[idx], ...state.updatePatch };
        return { data: rows[idx], error: null };
      }

      if (state.insertPayload) {
        const withId = {
          id: state.insertPayload.id || genId(tableName),
          ...state.insertPayload,
        };
        rows.push(withId);
        return { data: withId, error: null };
      }

      if (state.upsertPayload) {
        const match = rows.find((r) =>
          r.organization_id === state.upsertPayload.organization_id &&
          r.instantly_message_id === state.upsertPayload.instantly_message_id
        );
        if (match) {
          Object.assign(match, state.upsertPayload);
          return { data: match, error: null };
        }
        const withId = {
          id: state.upsertPayload.id || genId(tableName),
          ...state.upsertPayload,
        };
        rows.push(withId);
        return { data: withId, error: null };
      }

      const found = rows.find(matches);
      return { data: found ?? null, error: null };
    }

    return api;
  }

  return {
    from: (table) => query(table),
    __tables: tables,
  };
}

// --- Fixtures ----------------------------------------------------------
const ORG_ID = "org-fixture-0001";
const CLIENT_ID = "client-fixture-0001";
const CAMPAIGN_ID = "campaign-fixture-0001";

const CLIENT_FIXTURE_HOT = {
  id: CLIENT_ID,
  organization_id: ORG_ID,
  name: "Fixture Client",
  notification_email: "ops@fixture.example",
  auto_notify_classes: [
    "true_interest",
    "meeting_booked",
    "qualifying_question",
    "referral_forward",
    "unsubscribe", // Not normally hot, but included so the deterministic test triggers notify
  ],
  persona_name: "Mike Rodriguez",
};

const CLIENT_FIXTURE_SILENT = {
  id: "client-fixture-0002",
  organization_id: ORG_ID,
  name: "Fixture Silent",
  notification_email: "ops@silent.example",
  auto_notify_classes: ["true_interest"], // unsubscribe NOT in list
  persona_name: "Mike Rodriguez",
};

// --- Load modules ------------------------------------------------------
const { correlateTag } = await import("../src/lib/replies/tag.ts");
const { runReplyPipeline } = await import("../src/lib/replies/pipeline.ts");

// =====================================================================
// Part 1: correlateTag
// =====================================================================
console.log("\n■ correlateTag: existing row with body → patches tag, bothSignalsPresent=true");
{
  const admin = makeStub({
    lead_replies: [
      {
        id: "reply-001",
        organization_id: ORG_ID,
        client_id: CLIENT_ID,
        campaign_id: CAMPAIGN_ID,
        instantly_message_id: "<msg-abc@mail>",
        instantly_email_id: "e-abc",
        lead_email: "prospect@example.com",
        body_text: "I'm interested",
        instantly_category: null,
        status: "new",
      },
    ],
  });

  const result = await correlateTag(
    {
      event_type: "lead_interested",
      message_id: "<msg-abc@mail>",
      lead_email: "prospect@example.com",
    },
    {
      organization_id: ORG_ID,
      client_id: CLIENT_ID,
      campaign_id: CAMPAIGN_ID,
      instantly_campaign_id: "inst-campaign-abc",
    },
    admin
  );

  assert(result.replyId === "reply-001", "returns existing row id");
  assert(result.bothSignalsPresent === true, "bothSignalsPresent=true (body already stored)");
  assert(result.created === false, "created=false");
  assert(
    admin.__tables.lead_replies[0].instantly_category === "lead_interested",
    "writes instantly_category onto the row"
  );
}

console.log("\n■ correlateTag: existing placeholder without body → patches tag, bothSignalsPresent=false");
{
  const admin = makeStub({
    lead_replies: [
      {
        id: "reply-002",
        organization_id: ORG_ID,
        client_id: CLIENT_ID,
        instantly_message_id: "<msg-def@mail>",
        lead_email: "prospect2@example.com",
        body_text: null,
        instantly_category: null,
        status: "new",
      },
    ],
  });

  const result = await correlateTag(
    {
      event_type: "lead_wrong_person",
      message_id: "<msg-def@mail>",
      lead_email: "prospect2@example.com",
    },
    {
      organization_id: ORG_ID,
      client_id: CLIENT_ID,
      campaign_id: CAMPAIGN_ID,
      instantly_campaign_id: "inst-campaign-def",
    },
    admin
  );

  assert(result.replyId === "reply-002", "returns existing row id");
  assert(result.bothSignalsPresent === false, "bothSignalsPresent=false (no body yet)");
  assert(
    admin.__tables.lead_replies[0].instantly_category === "lead_wrong_person",
    "writes instantly_category"
  );
}

console.log("\n■ correlateTag: no existing row → creates placeholder");
{
  const admin = makeStub();

  const result = await correlateTag(
    {
      event_type: "lead_interested",
      message_id: "<msg-ghi@mail>",
      instantly_email_id: "e-ghi",
      lead_email: "fresh@example.com",
      first_name: "Fresh",
      last_name: "Person",
    },
    {
      organization_id: ORG_ID,
      client_id: CLIENT_ID,
      campaign_id: CAMPAIGN_ID,
      instantly_campaign_id: "inst-campaign-ghi",
    },
    admin
  );

  assert(result.replyId !== null, "returns generated id for new placeholder");
  assert(result.created === true, "created=true");
  assert(result.bothSignalsPresent === false, "bothSignalsPresent=false (no body yet)");
  assert(admin.__tables.lead_replies.length === 1, "one row inserted");
  const row = admin.__tables.lead_replies[0];
  assert(row.instantly_category === "lead_interested", "placeholder carries the tag");
  assert(row.lead_email === "fresh@example.com", "placeholder carries lead_email");
  assert(row.instantly_message_id === "<msg-ghi@mail>", "placeholder carries message_id");
}

console.log("\n■ correlateTag: non-lead_ event returns null without touching DB");
{
  const admin = makeStub();
  const result = await correlateTag(
    { event_type: "email_sent", lead_email: "x@example.com" },
    {
      organization_id: ORG_ID,
      client_id: CLIENT_ID,
      campaign_id: CAMPAIGN_ID,
      instantly_campaign_id: "x",
    },
    admin
  );
  assert(result.replyId === null, "returns null for non-lead_ event");
  assert(admin.__tables.lead_replies.length === 0, "no rows created");
}

// =====================================================================
// Part 2: runReplyPipeline
// =====================================================================

// We disable Claude for these runs so the pipeline's claude=null branch
// exercises deterministically. decide.ts then picks the prefilter's
// suggested_class (unsubscribe, ooo, etc.) as final_class.
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
const savedResendKey = process.env.RESEND_API_KEY;
const { _resetAnthropicForTests } = await import("../src/lib/ai/client.ts");
delete process.env.ANTHROPIC_API_KEY;
_resetAnthropicForTests();
// Remove Resend too so the notify path short-circuits if it tries to send.
// (We test the skip paths here; happy-path notify is covered by the
// separate scripts/send-test-notification.mjs integration harness.)
delete process.env.RESEND_API_KEY;

console.log("\n■ runReplyPipeline: row missing → skipped=reply_not_found");
{
  const admin = makeStub();
  const result = await runReplyPipeline("does-not-exist", admin);
  assert(result.skipped === true, "skipped=true");
  assert(result.skippedReason === "reply_not_found", "reason=reply_not_found");
}

console.log("\n■ runReplyPipeline: already classified → idempotent skip");
{
  const admin = makeStub({
    lead_replies: [
      {
        id: "reply-done",
        organization_id: ORG_ID,
        client_id: CLIENT_ID,
        body_text: "hello",
        final_class: "true_interest",
        status: "classified",
      },
    ],
  });
  const result = await runReplyPipeline("reply-done", admin);
  assert(result.skipped === true, "skipped=true");
  assert(result.skippedReason === "already_classified", "reason=already_classified");
  assert(result.finalClass === "true_interest", "preserves existing final_class");
}

console.log("\n■ runReplyPipeline: no body_text → skipped=no_body_yet");
{
  const admin = makeStub({
    lead_replies: [
      {
        id: "reply-empty",
        organization_id: ORG_ID,
        client_id: CLIENT_ID,
        body_text: null,
        status: "new",
      },
    ],
  });
  const result = await runReplyPipeline("reply-empty", admin);
  assert(result.skipped === true, "skipped=true");
  assert(result.skippedReason === "no_body_yet", "reason=no_body_yet");
}

console.log("\n■ runReplyPipeline: unsubscribe reply → classifies, notify-SKIPPED for client without class in auto_notify");
{
  // Body is an unsubscribe phrase — prefilter hard-overrides to 'unsubscribe'.
  const admin = makeStub({
    lead_replies: [
      {
        id: "reply-unsub-1",
        organization_id: ORG_ID,
        client_id: CLIENT_FIXTURE_SILENT.id,
        body_text: "Please remove me from your list.",
        from_address: "prospect@example.com",
        instantly_category: "lead_unsubscribed",
        keyword_flags: [],
        status: "new",
      },
    ],
    clients: [CLIENT_FIXTURE_SILENT],
  });

  const result = await runReplyPipeline("reply-unsub-1", admin);
  assert(result.skipped === false, "pipeline ran (skipped=false)");
  assert(result.finalClass === "unsubscribe", "final_class=unsubscribe (prefilter override)");
  assert(result.notified === false, "notified=false");
  assert(
    result.notifySkippedReason === "class_not_in_auto_notify",
    "notify-skipped reason=class_not_in_auto_notify"
  );
  const stored = admin.__tables.lead_replies[0];
  assert(stored.final_class === "unsubscribe", "DB row final_class=unsubscribe");
  assert(stored.status === "classified", "DB row status=classified");
  assert(stored.classified_at, "DB row classified_at stamped");
}

console.log("\n■ runReplyPipeline: hot client but no notification_email → notify-SKIPPED=no_notification_email");
{
  const clientNoEmail = { ...CLIENT_FIXTURE_HOT, notification_email: null };
  const admin = makeStub({
    lead_replies: [
      {
        id: "reply-unsub-2",
        organization_id: ORG_ID,
        client_id: clientNoEmail.id,
        body_text: "Please unsubscribe me.",
        from_address: "prospect@example.com",
        instantly_category: "lead_unsubscribed",
        keyword_flags: [],
        status: "new",
      },
    ],
    clients: [clientNoEmail],
  });

  const result = await runReplyPipeline("reply-unsub-2", admin);
  assert(result.skipped === false, "pipeline ran");
  assert(result.finalClass === "unsubscribe", "final_class=unsubscribe");
  assert(result.notified === false, "notified=false");
  assert(
    result.notifySkippedReason === "no_notification_email",
    "notify-skipped reason=no_notification_email"
  );
}

// Restore env so downstream tests / subsequent script runs behave normally.
if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
if (savedResendKey !== undefined) process.env.RESEND_API_KEY = savedResendKey;
_resetAnthropicForTests();

// --- Summary ---
console.log("\n" + "─".repeat(40));
if (fail === 0) {
  console.log(`✓ ${pass} assertions passed`);
  process.exit(0);
} else {
  console.error(`✗ ${fail} failed, ${pass} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
