#!/usr/bin/env node
// Inserts a synthetic lead_replies row with controlled body text, then runs
// the real classification pipeline against the prod DB. Used to prove the
// firewall: which classes fire a Resend notification, which stay silent.
//
// Bypasses the webhook handler's getEmail() enrichment step — that call
// would 404 against Instantly for a fake email_id. Everything downstream
// (prefilter + Claude + decide + notify) is the exact production path.
//
// Usage:
//   npx tsx scripts/fire-synthetic-reply.mjs <case>
// where <case> is:
//   unsubscribe      — expect final_class=unsubscribe, notified=false
//   referral_forward — expect final_class=referral_forward, notified=true,
//                      referral_contact populated, Resend email lands

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
loadEnvLocal();

const CASE = process.argv[2];
const CASES = {
  unsubscribe: {
    body: "Please remove me from your list. I do not want to receive these emails anymore. Unsubscribe me now.",
    subject: "Re: Would you be interested?",
    expected: { final_class: "unsubscribe", notified: false },
  },
  referral_forward: {
    body:
      "Thanks for reaching out, but I'm not the right person for this at our company. Please try jane@othercorp.example — she handles partnerships and would be the better contact.",
    subject: "Re: Would you be interested?",
    expected: { final_class: "referral_forward", notified: true },
  },
};

const spec = CASES[CASE];
if (!spec) {
  console.error(`Usage: npx tsx scripts/fire-synthetic-reply.mjs <${Object.keys(CASES).join("|")}>`);
  process.exit(1);
}

// Fixtures — Smoke Test client / campaign / eaccount in prod Supabase.
const ORGANIZATION_ID = "bfc96611-8b2f-49c2-b4e0-49ebadc295e1";
const CLIENT_ID = "4c39db38-2b7c-4183-ae7e-bb5eb4647719";
const CAMPAIGN_ID = "f7bc479a-5157-495b-a253-17089506c2b0";
const INSTANTLY_CAMPAIGN_ID = "4a890fb0-a221-4156-8562-917d4d2f5a8c";
const EACCOUNT = "daniel@workwithdanielt.com";
const LEAD_EMAIL = "lemonade504@gmail.com";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const stamp = Date.now();
const syntheticEmailId = `smoke-${CASE}-${stamp}`;
const syntheticMessageId = `<smoke-${CASE}-${stamp}@synthetic.leadstart>`;

console.log(`[smoke] case=${CASE}`);
console.log(`[smoke] Inserting synthetic row (email_id=${syntheticEmailId})...`);

const { data: inserted, error: insertError } = await admin
  .from("lead_replies")
  .insert({
    organization_id: ORGANIZATION_ID,
    client_id: CLIENT_ID,
    campaign_id: CAMPAIGN_ID,
    instantly_campaign_id: INSTANTLY_CAMPAIGN_ID,
    instantly_email_id: syntheticEmailId,
    instantly_message_id: syntheticMessageId,
    eaccount: EACCOUNT,
    lead_email: LEAD_EMAIL,
    lead_name: "Synthetic Smoke",
    lead_company: "OtherCorp Example",
    lead_phone_e164: "+15555555555",
    from_address: LEAD_EMAIL,
    to_address: EACCOUNT,
    subject: spec.subject,
    body_text: spec.body,
    body_html: `<div dir="ltr">${spec.body}</div>`,
    received_at: new Date().toISOString(),
    status: "new",
    raw_payload: { synthetic: true, case: CASE, stamp },
  })
  .select("id")
  .single();

if (insertError) {
  console.error("[smoke] Insert failed:", insertError);
  process.exit(1);
}

const replyId = inserted.id;
console.log(`[smoke] Inserted reply id=${replyId}`);

const { runReplyPipeline } = await import("../src/lib/replies/pipeline.ts");

console.log(`[smoke] Running pipeline...`);
let result;
try {
  result = await runReplyPipeline(replyId, admin);
} catch (err) {
  console.error(`[smoke] Pipeline threw:`, err);
  process.exit(1);
}
console.log(`[smoke] Pipeline result:`, JSON.stringify(result, null, 2));

const { data: final } = await admin
  .from("lead_replies")
  .select(
    "id, status, final_class, claude_class, claude_confidence, claude_reason, referral_contact, notified_at, notification_status, notification_email_id, notification_last_error, keyword_flags"
  )
  .eq("id", replyId)
  .single();

console.log(`[smoke] Final row state:`, JSON.stringify(final, null, 2));

const notified = !!final.notified_at;
const classPass = final.final_class === spec.expected.final_class;
const notifyPass = notified === spec.expected.notified;

if (classPass && notifyPass) {
  console.log(`\nPASS: ${CASE}`);
  console.log(`  final_class=${final.final_class} (expected ${spec.expected.final_class})`);
  console.log(`  notified=${notified} (expected ${spec.expected.notified})`);
  if (final.referral_contact) console.log(`  referral_contact=${final.referral_contact}`);
  process.exit(0);
} else {
  console.error(`\nFAIL: ${CASE}`);
  console.error(`  final_class=${final.final_class} (expected ${spec.expected.final_class}) [${classPass ? "ok" : "MISMATCH"}]`);
  console.error(`  notified=${notified} (expected ${spec.expected.notified}) [${notifyPass ? "ok" : "MISMATCH"}]`);
  process.exit(1);
}
