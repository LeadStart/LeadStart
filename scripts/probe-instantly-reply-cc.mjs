#!/usr/bin/env node
/**
 * Probe Instantly's POST /api/v2/emails/:id/reply to answer three questions
 * before we wire the real AI reply pipeline:
 *
 *   1. Does the reply endpoint accept a CC field?
 *   2. What's the exact field name (cc_address_email_list vs cc vs ...)?
 *   3. Do CC'd addresses actually receive the email when sent?
 *
 * Usage (all commands require INSTANTLY_API_KEY in env):
 *
 *   # List 5 recent received emails so you can pick an ID for a real probe
 *   node scripts/probe-instantly-reply-cc.mjs list
 *   node scripts/probe-instantly-reply-cc.mjs list <campaign_id>
 *
 *   # Phase 1: probe CC field names against a fake UUID (zero-risk)
 *   node scripts/probe-instantly-reply-cc.mjs probe-fields
 *
 *   # Phase 2: ACTUALLY send a reply with CC (real delivery test)
 *   #   - <email_id> must be a received email in an Instantly campaign you control
 *   #   - <cc_address> must be a mailbox YOU control so you can verify delivery
 *   #   - must pass --confirm to prevent accidents
 *   node scripts/probe-instantly-reply-cc.mjs send <email_id> <cc_address> --confirm
 *
 * Example end-to-end probe:
 *   export INSTANTLY_API_KEY=...
 *   node scripts/probe-instantly-reply-cc.mjs probe-fields
 *   node scripts/probe-instantly-reply-cc.mjs list
 *   node scripts/probe-instantly-reply-cc.mjs send <id-from-list> you+cc@yourdomain.com --confirm
 */

const BASE_URL = "https://api.instantly.ai/api/v2";
const API_KEY = process.env.INSTANTLY_API_KEY;

if (!API_KEY) {
  console.error("ERROR: Set INSTANTLY_API_KEY env var before running.");
  console.error("  PowerShell: $env:INSTANTLY_API_KEY=\"Nz...\"");
  console.error("  bash:       export INSTANTLY_API_KEY=Nz...");
  process.exit(1);
}

// Valid UUID v4 format but guaranteed not to exist in Instantly.
// Picked to defeat path-level UUID validators so the request reaches body validation.
const FAKE_UUID = "00000000-0000-0000-0000-000000000000";

// Candidate CC field names to try, in order of likelihood.
// The repo's existing InstantlyEmail type uses `to_address_email_list`,
// so `cc_address_email_list` is the convention-matching bet.
const CC_FIELD_CANDIDATES = [
  "cc_address_email_list",
  "cc_addresses",
  "cc",
  "ccs",
  "cc_emails",
];

// Minimal body shapes to try. Instantly's own InstantlyEmail type shows body
// can be { text, html } OR a plain string, so we cover both.
const BODY_CANDIDATES = [
  { body: { text: "probe", html: "<p>probe</p>" }, subject: "probe" },
  { body: "probe", subject: "probe" },
];

async function instantlyRequest(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let parsed = raw;
  try { parsed = JSON.parse(raw); } catch {}
  return { status: res.status, body: parsed, rawLength: raw.length };
}

function fmt(obj) {
  return JSON.stringify(obj, null, 2);
}

function interpretProbeResponse(ccField, resp) {
  const { status, body } = resp;
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const mentionsThisCcField = new RegExp(`\\b${ccField}\\b`, "i").test(bodyStr);
  const mentionsUnknownField = /unknown.{0,20}field|unexpected.{0,20}field|not allowed|extra.{0,20}fields/i.test(bodyStr);
  const mentionsNotFound = /not found|does.{0,4}not exist|no such/i.test(bodyStr);
  const mentionsMissingBody = /body.*(required|missing)|subject.*required|must.*provide/i.test(bodyStr);

  if (status === 401 || status === 403) {
    return { verdict: "AUTH_FAIL", detail: "API key rejected — check INSTANTLY_API_KEY" };
  }
  if (status === 404 || mentionsNotFound) {
    return { verdict: "FIELD_LIKELY_ACCEPTED", detail: `Got ${status} about the email ID, not about '${ccField}'. Field likely accepted (or silently dropped — Phase 2 confirms).` };
  }
  if (status === 400 && mentionsThisCcField && mentionsUnknownField) {
    return { verdict: "FIELD_REJECTED", detail: `Server explicitly rejected '${ccField}'.` };
  }
  if (status === 400 && mentionsUnknownField) {
    return { verdict: "SOME_FIELD_REJECTED", detail: "Server rejected an unknown field — check if it names ours." };
  }
  if (status === 400 && mentionsMissingBody) {
    return { verdict: "FIELD_LIKELY_ACCEPTED", detail: `Got 400 about body/subject, not '${ccField}'. Field likely accepted.` };
  }
  if (status >= 200 && status < 300) {
    return { verdict: "UNEXPECTED_SUCCESS", detail: "The fake UUID somehow succeeded — did Instantly change UUIDs? Inspect response." };
  }
  return { verdict: "INCONCLUSIVE", detail: `Got ${status}. Needs manual inspection.` };
}

// ---------- Commands ----------

async function cmdList(campaignId) {
  const params = new URLSearchParams({ email_type: "received", limit: "5" });
  if (campaignId) params.set("campaign_id", campaignId);
  const resp = await instantlyRequest("GET", `/emails?${params.toString()}`);

  if (resp.status !== 200) {
    console.error("Request failed:", fmt(resp));
    process.exit(1);
  }

  const items = resp.body.items || resp.body || [];
  if (!Array.isArray(items) || items.length === 0) {
    console.log("No received emails found" + (campaignId ? ` for campaign ${campaignId}` : "") + ".");
    console.log("Create a tiny test campaign, send it to a mailbox you control,");
    console.log("and reply from that mailbox. Then rerun this command.");
    return;
  }

  console.log(`Found ${items.length} recent received emails:\n`);
  for (const e of items) {
    console.log(`  id:         ${e.id}`);
    console.log(`  from:       ${e.from_address_email}`);
    console.log(`  subject:    ${e.subject || "(no subject)"}`);
    console.log(`  thread_id:  ${e.thread_id || "-"}`);
    console.log(`  timestamp:  ${e.timestamp_email || e.timestamp_created}`);
    console.log(`  campaign:   ${e.campaign_id || "-"}`);
    console.log("");
  }
  console.log("Pick the id of a TEST reply you control, then:");
  console.log("  node scripts/probe-instantly-reply-cc.mjs send <id> <your-cc-address> --confirm");
}

async function cmdProbeFields() {
  console.log("Phase 1 — Field-name discovery (zero-risk, fake UUID)\n");
  console.log(`Target: POST ${BASE_URL}/emails/${FAKE_UUID}/reply`);
  console.log(`Trying ${CC_FIELD_CANDIDATES.length} CC field names × ${BODY_CANDIDATES.length} body shapes\n`);

  const results = [];
  for (const ccField of CC_FIELD_CANDIDATES) {
    for (let i = 0; i < BODY_CANDIDATES.length; i++) {
      const bodyShape = BODY_CANDIDATES[i];
      const payload = { ...bodyShape, [ccField]: ["probe-cc@example.com"] };
      const resp = await instantlyRequest("POST", `/emails/${FAKE_UUID}/reply`, payload);
      const interp = interpretProbeResponse(ccField, resp);
      results.push({ ccField, bodyShape: i === 0 ? "{text,html}" : "string", ...interp, status: resp.status });
      console.log(`  [${ccField}] body=${i === 0 ? "{text,html}" : "string"} → ${resp.status} ${interp.verdict}`);
      console.log(`    ${interp.detail}`);
      console.log(`    response: ${truncate(typeof resp.body === "string" ? resp.body : fmt(resp.body), 200)}\n`);
    }
  }

  console.log("\n========== SUMMARY ==========");
  const accepted = results.filter(r => r.verdict === "FIELD_LIKELY_ACCEPTED").map(r => r.ccField);
  const rejected = results.filter(r => r.verdict === "FIELD_REJECTED").map(r => r.ccField);
  const authFail = results.some(r => r.verdict === "AUTH_FAIL");

  if (authFail) {
    console.log("❌ Auth failed for one or more requests. Fix INSTANTLY_API_KEY and rerun.");
    process.exit(1);
  }
  if (accepted.length > 0) {
    const uniq = [...new Set(accepted)];
    console.log(`✓ Likely accepted: ${uniq.join(", ")}`);
    console.log("  BUT: Phase 1 can't distinguish 'accepted' from 'silently ignored'.");
    console.log("  You MUST run Phase 2 (send command) to confirm CC'd addresses actually receive the email.");
  }
  if (rejected.length > 0) {
    const uniq = [...new Set(rejected)];
    console.log(`✗ Explicitly rejected: ${uniq.join(", ")}`);
  }
  if (accepted.length === 0 && rejected.length === 0) {
    console.log("? Inconclusive — inspect the responses above. The API may be returning non-standard errors.");
  }
}

async function cmdSend(emailId, ccAddress, hasConfirm) {
  if (!emailId || !ccAddress) {
    console.error("Usage: node scripts/probe-instantly-reply-cc.mjs send <email_id> <cc_address> --confirm");
    process.exit(1);
  }
  if (!hasConfirm) {
    console.error("⚠  Missing --confirm flag.");
    console.error("   This command will send a REAL email via Instantly.");
    console.error("   Only use it on a test campaign + test CC address you control.");
    process.exit(1);
  }

  console.log("Phase 2 — Live delivery check\n");
  console.log(`  Reply target: ${BASE_URL}/emails/${emailId}/reply`);
  console.log(`  CC address:   ${ccAddress}`);
  console.log("");
  console.log("Sending in 5 seconds — Ctrl+C to abort...");
  for (let i = 5; i > 0; i--) {
    process.stdout.write(`\r  ${i}...`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log("\r  sending...\n");

  // Use the field name(s) that Phase 1 surfaced as accepted.
  // We try the top candidate first; if it fails we report and stop (don't spam real sends).
  const payload = {
    body: {
      text: "This is an automated probe from LeadStart. Please disregard.",
      html: "<p>This is an automated probe from LeadStart. Please disregard.</p>",
    },
    subject: "Re: LeadStart probe",
    cc_address_email_list: [ccAddress],
  };

  const resp = await instantlyRequest("POST", `/emails/${emailId}/reply`, payload);
  console.log(`Response status: ${resp.status}`);
  console.log(`Response body:\n${fmt(resp.body)}\n`);

  if (resp.status >= 200 && resp.status < 300) {
    console.log("✓ Instantly accepted the reply request.");
    console.log("");
    console.log("Now check manually:");
    console.log(`  1. Did the prospect mailbox (the lead in this thread) receive the reply?`);
    console.log(`  2. Did ${ccAddress} receive a copy?`);
    console.log(`  3. In Gmail, is the reply threaded under the original campaign email?`);
    console.log("");
    console.log("If #2 is YES  → cc_address_email_list works. Build path (A) from the plan.");
    console.log("If #2 is NO   → field was silently dropped. Build path (B) using /emails/:id/forward.");
    console.log("If #3 is NO   → threading broken, investigate headers.");
  } else {
    console.log("✗ Instantly rejected the reply. Inspect the error above.");
    console.log("  Re-run 'probe-fields' to see if a different CC field name is accepted.");
  }
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}

// ---------- Dispatch ----------

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const hasConfirm = args.includes("--confirm");
  const positional = args.filter(a => !a.startsWith("--"));

  switch (cmd) {
    case "list":
      await cmdList(positional[0]);
      break;
    case "probe-fields":
      await cmdProbeFields();
      break;
    case "send":
      await cmdSend(positional[0], positional[1], hasConfirm);
      break;
    default:
      console.error("Unknown command. Usage:");
      console.error("  node scripts/probe-instantly-reply-cc.mjs list [campaign_id]");
      console.error("  node scripts/probe-instantly-reply-cc.mjs probe-fields");
      console.error("  node scripts/probe-instantly-reply-cc.mjs send <email_id> <cc_address> --confirm");
      process.exit(1);
  }
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
