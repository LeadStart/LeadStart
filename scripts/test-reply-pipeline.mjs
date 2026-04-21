#!/usr/bin/env node
/**
 * Smoke test for the reply-routing pipeline (commit #3).
 *
 * Runs the webhook fixtures through:
 *   1. keyword-prefilter → assert expected flags + suggested_class
 *   2. ingest.normalizeReplyFromInstantlyEmail → assert the row shape,
 *      especially that `eaccount` is captured from the Instantly email.
 *   3. send.buildReplyRequest (round-trip) → assert the reply API body
 *      we'd send back uses the same `eaccount` + `reply_to_uuid`.
 *
 * No network. No DB. Pure-function tests.
 *
 * Usage:
 *   npx tsx scripts/test-reply-pipeline.mjs
 *   # or after `npm run build`:
 *   node scripts/test-reply-pipeline.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// We import the TS modules via tsx so this script doesn't require a build.
// Run with: npx tsx scripts/test-reply-pipeline.mjs
// (tsx is already a dev dep via Next.js toolchain.)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, "fixtures");

// ----------- Dynamic import (tsx resolves ts files) -----------
const { runKeywordPrefilter } = await import("../src/lib/replies/keyword-prefilter.ts");
const { normalizeReplyFromInstantlyEmail } = await import("../src/lib/replies/ingest.ts");
const { buildReplyRequest } = await import("../src/lib/replies/send.ts");
const { decideFinalClass } = await import("../src/lib/replies/decide.ts");

// Load Claude lazily — only if the API key is set, so the offline prefilter +
// ingest assertions always work without requiring ANTHROPIC_API_KEY.
const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY;
const classify = HAS_ANTHROPIC_KEY
  ? (await import("../src/lib/ai/classifier.ts")).classifyReply
  : null;

// ----------- Test harness -----------
let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    pass++;
  } else {
    fail++;
    const line = `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
    failures.push(line);
    console.error(`  ✗ ${line}`);
  }
}

// ----------- Fixture → InstantlyEmail adapter -----------
// Real Instantly webhooks are sparse; the full Email object comes from
// GET /api/v2/emails/{id}. The fixtures include the enriched fields we
// care about. This mimics what the webhook handler will get after
// enrichment.
function fixtureToInstantlyEmail(fx) {
  return {
    id: fx.instantly_email_id,
    timestamp_created: fx.timestamp,
    timestamp_email: fx.timestamp,
    message_id: fx.message_id,
    subject: fx.reply_subject,
    body: { text: fx.reply_body },
    from_address_email: fx.lead_email,
    to_address_email_list: [fx.eaccount],
    eaccount: fx.eaccount,
    campaign_id: fx.campaign_id,
    thread_id: fx.thread_id,
  };
}

const MOCK_CTX = {
  organization_id: "bfc96611-8b2f-49c2-b4e0-49ebadc295e1",
  client_id: "9b15943d-ef85-4b5c-a9cb-01c911c542b8",
  campaign_id: "64d642b5-254a-4ea1-9288-d61274f1d491",
};

// ----------- Per-fixture expectations -----------
// prefilter expectations are deterministic; Claude class is a range.
const EXPECTATIONS = {
  "webhook-lead-interested.json": {
    prefilterFlags: [],
    prefilterSuggested: null,
    referralExtracted: false,
    // Claude layer + decide merger expectations (when ANTHROPIC_API_KEY present)
    expectedFinalClasses: ["true_interest", "qualifying_question"],
  },
  "webhook-lead-wrong-person-referral.json": {
    prefilterFlags: ["wrong_person_phrase", "referral_phrase", "referral_email_present"],
    prefilterSuggested: "referral_forward",
    referralExtracted: true,
    referralEmail: "priya.sharma@meridian-systems.example",
    expectedFinalClasses: ["referral_forward"],
  },
  "webhook-lead-wrong-person-no-referral.json": {
    prefilterFlags: ["wrong_person_phrase"],
    prefilterSuggested: "wrong_person_no_referral",
    referralExtracted: false,
    expectedFinalClasses: ["wrong_person_no_referral"],
  },
  "webhook-lead-ooo.json": {
    prefilterFlags: ["ooo_phrase"],
    prefilterSuggested: "ooo",
    referralExtracted: false,
    expectedFinalClasses: ["ooo"],
  },
  "webhook-lead-unsubscribed.json": {
    prefilterFlags: ["unsubscribe_phrase"],
    prefilterSuggested: "unsubscribe",
    referralExtracted: false,
    expectedFinalClasses: ["unsubscribe"],
  },
  "webhook-reply-received-generic.json": {
    prefilterFlags: [],
    prefilterSuggested: null,
    referralExtracted: false,
    // Alex Winters asks compliance + pricing questions — clear qualifying_question
    expectedFinalClasses: ["qualifying_question", "true_interest"],
  },
};

// ----------- Run -----------
console.log("Reply-pipeline smoke test\n");

const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
if (fixtureFiles.length === 0) {
  console.error("No fixtures found.");
  process.exit(1);
}

for (const filename of fixtureFiles) {
  const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, filename), "utf8"));
  const expected = EXPECTATIONS[filename];
  if (!expected) continue;

  console.log(`■ ${filename}`);

  // --- 1. Prefilter ---
  const prefilter = runKeywordPrefilter(fx.reply_body, fx.lead_email);
  assertEqual(
    prefilter.flags.sort(),
    expected.prefilterFlags.sort(),
    `  [${filename}] prefilter flags`
  );
  assertEqual(
    prefilter.suggested_class,
    expected.prefilterSuggested,
    `  [${filename}] prefilter suggested_class`
  );

  // --- 2. Ingest ---
  const email = fixtureToInstantlyEmail(fx);
  const ingested = normalizeReplyFromInstantlyEmail(email, fx, MOCK_CTX);

  // THE CRITICAL ASSERTION — eaccount is captured from the Instantly email
  assertEqual(
    ingested.eaccount,
    fx.eaccount,
    `  [${filename}] ingested.eaccount matches Instantly email.eaccount`
  );
  assertEqual(
    ingested.instantly_email_id,
    fx.instantly_email_id,
    `  [${filename}] ingested.instantly_email_id`
  );
  assertEqual(
    ingested.instantly_message_id,
    fx.message_id,
    `  [${filename}] ingested.instantly_message_id`
  );
  assertEqual(
    ingested.thread_id,
    fx.thread_id,
    `  [${filename}] ingested.thread_id`
  );
  assertEqual(
    ingested.lead_email,
    fx.lead_email,
    `  [${filename}] ingested.lead_email`
  );
  assertEqual(
    ingested.subject,
    fx.reply_subject,
    `  [${filename}] ingested.subject`
  );
  assertEqual(
    ingested.keyword_flags.sort(),
    expected.prefilterFlags.sort(),
    `  [${filename}] ingested.keyword_flags (same as prefilter)`
  );
  assertEqual(
    ingested.referral_contact !== null,
    expected.referralExtracted,
    `  [${filename}] referral_contact populated when expected`
  );
  if (expected.referralExtracted) {
    assertEqual(
      ingested.referral_contact?.email,
      expected.referralEmail,
      `  [${filename}] extracted referral email`
    );
  }

  // --- 3. Send round-trip ---
  // Simulate: client composes a reply via portal. We construct the
  // InstantlyReplyRequest we'd POST to /emails/reply. Eaccount must survive.
  const replyRequest = buildReplyRequest({
    reply: {
      eaccount: ingested.eaccount,
      instantly_email_id: ingested.instantly_email_id,
      subject: ingested.subject,
      body_text: ingested.body_text,
    },
    body_text: "Thanks for the reply — I'll give you a call shortly.",
    cc_addresses: ["david@cabrera-auto.example"],
  });

  assertEqual(
    replyRequest.eaccount,
    fx.eaccount,
    `  [${filename}] reply request.eaccount roundtrips (ingest → store → send)`
  );
  assertEqual(
    replyRequest.reply_to_uuid,
    fx.instantly_email_id,
    `  [${filename}] reply request.reply_to_uuid roundtrips`
  );
  assertEqual(
    replyRequest.cc_address_email_list,
    "david@cabrera-auto.example",
    `  [${filename}] reply request.cc_address_email_list`
  );
  assert(
    replyRequest.subject.startsWith("Re: ") || replyRequest.subject === fx.reply_subject,
    `  [${filename}] reply request.subject prefixed with Re:`
  );

  // --- 4. Claude classifier + decide merger (only if API key present) ---
  if (classify) {
    const claudeOut = await classify({
      body: fx.reply_body,
      instantly_category: fx.event_type.startsWith("lead_") ? fx.event_type : null,
      prefilter,
      persona_name: "Mike Rodriguez",
    });

    // Claude's own output should satisfy a basic shape check
    assert(
      typeof claudeOut.class === "string" && claudeOut.class.length > 0,
      `  [${filename}] claude.class is a non-empty string`
    );
    assert(
      typeof claudeOut.confidence === "number" &&
        claudeOut.confidence >= 0 &&
        claudeOut.confidence <= 1,
      `  [${filename}] claude.confidence in [0,1]`
    );

    // Run the merger
    const decision = decideFinalClass({
      instantly_category: fx.event_type.startsWith("lead_") ? fx.event_type : null,
      prefilter,
      claude: claudeOut,
    });

    assert(
      expected.expectedFinalClasses.includes(decision.final_class),
      `  [${filename}] decide.final_class in [${expected.expectedFinalClasses.join(", ")}] (got: ${decision.final_class}, claude=${claudeOut.class}@${claudeOut.confidence.toFixed(2)})`
    );

    // Referral contact round-trips when the final class is referral_forward
    if (decision.final_class === "referral_forward") {
      assert(
        decision.referral_contact !== null,
        `  [${filename}] decide.referral_contact populated for referral_forward`
      );
    }

    console.log(
      `    [claude] class=${claudeOut.class} conf=${claudeOut.confidence.toFixed(2)} → final=${decision.final_class}`
    );
  }

  console.log("");
}

// ----------- Summary -----------
console.log("─".repeat(40));
if (!HAS_ANTHROPIC_KEY) {
  console.log("(ANTHROPIC_API_KEY not set — Claude classifier + decide merger assertions skipped.)");
}
if (fail === 0) {
  console.log(`✓ ${pass} assertions passed`);
  process.exit(0);
} else {
  console.error(`✗ ${fail} failed, ${pass} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
