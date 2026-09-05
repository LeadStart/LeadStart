#!/usr/bin/env node
/**
 * Unit tests for the internal-automations config + delivery pure functions
 * (migration 00087). No network, no DB. Run: npx tsx scripts/test-automation-settings.ts
 */
import {
  normalizeAutomationSettings,
  toAutomationStatus,
  isHttpUrl,
} from "../src/lib/automations/settings.ts";
import {
  shouldNotifyForClass,
  buildReplyEvent,
  renderSlackPayload,
  renderWebhookBody,
  renderEmail,
  signBody,
  snippet,
} from "../src/lib/notifications/internal-automations.ts";
import {
  DEFAULT_AUTOMATION_SETTINGS,
  type AutomationSettings,
  type Client,
  type LeadReply,
} from "../src/types/app.ts";

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
function ok(cond: boolean, msg: string) {
  eq(!!cond, true, msg);
}

// ── normalizeAutomationSettings ─────────────────────────────────────────────
console.log("normalizeAutomationSettings");
{
  const d = normalizeAutomationSettings(null);
  eq(d.enabled, false, "null → defaults (disabled)");
  eq(d.notify_on, "hot", "null → notify_on hot");
  eq(d.slack_webhook_url, "", "null → empty slack url");

  const partial = normalizeAutomationSettings({ enabled: true, notify_on: "all_replies" });
  eq(partial.enabled, true, "partial keeps provided enabled");
  eq(partial.notify_on, "all_replies", "partial keeps provided notify_on");
  eq(partial.notify_email, "", "partial fills missing from defaults");

  const bad = normalizeAutomationSettings({ enabled: "yes", notify_on: "banana", notify_email: 42 });
  eq(bad.enabled, false, "non-boolean enabled → default false");
  eq(bad.notify_on, "hot", "invalid notify_on → default hot");
  eq(bad.notify_email, "", "non-string email → default empty");

  const trimmed = normalizeAutomationSettings({ slack_webhook_url: "  https://x.test/h  " });
  eq(trimmed.slack_webhook_url, "https://x.test/h", "string fields are trimmed");

  const base: AutomationSettings = {
    ...DEFAULT_AUTOMATION_SETTINGS,
    slack_webhook_url: "https://kept.test",
    enabled: true,
  };
  const merged = normalizeAutomationSettings({ notify_on: "all_replies" }, base);
  eq(merged.slack_webhook_url, "https://kept.test", "merge over base keeps unset secret");
  eq(merged.enabled, true, "merge over base keeps unset enabled");
  eq(merged.notify_on, "all_replies", "merge over base applies provided");
}

// ── toAutomationStatus (masking) ─────────────────────────────────────────────
console.log("toAutomationStatus");
{
  const s: AutomationSettings = {
    enabled: true,
    notify_on: "hot",
    slack_webhook_url: "https://hooks.slack.com/services/T/B/x",
    notify_email: "teammate@co.com",
    outbound_webhook_url: "https://api.example.com/hooks/leadstart?t=1",
    outbound_webhook_secret: "shh",
  };
  const st = toAutomationStatus(s);
  eq(st.enabled, true, "status carries enabled");
  eq(st.notify_email, "teammate@co.com", "status carries notify_email (not secret)");
  eq(st.slack_webhook_url_set, true, "slack set → true");
  eq(st.outbound_webhook_url_set, true, "webhook url set → true");
  eq(st.outbound_webhook_url_host, "api.example.com", "webhook host extracted");
  eq(st.outbound_webhook_secret_set, true, "secret set → true");
  ok(!("slack_webhook_url" in st), "status never carries the raw slack url");
  ok(!("outbound_webhook_secret" in st), "status never carries the raw secret");

  const empty = toAutomationStatus(DEFAULT_AUTOMATION_SETTINGS);
  eq(empty.slack_webhook_url_set, false, "unset slack → false");
  eq(empty.outbound_webhook_url_host, null, "unset webhook → null host");
}

// ── isHttpUrl ────────────────────────────────────────────────────────────────
console.log("isHttpUrl");
eq(isHttpUrl("https://hooks.slack.com/x"), true, "https ok");
eq(isHttpUrl("http://localhost:3000/h"), true, "http ok");
eq(isHttpUrl("ftp://x.test"), false, "ftp rejected");
eq(isHttpUrl("not a url"), false, "garbage rejected");
eq(isHttpUrl(""), false, "empty rejected");

// ── shouldNotifyForClass ─────────────────────────────────────────────────────
console.log("shouldNotifyForClass");
{
  const hot: AutomationSettings = { ...DEFAULT_AUTOMATION_SETTINGS, notify_on: "hot" };
  const all: AutomationSettings = { ...DEFAULT_AUTOMATION_SETTINGS, notify_on: "all_replies" };
  eq(shouldNotifyForClass(hot, "true_interest"), true, "hot: true_interest fires");
  eq(shouldNotifyForClass(hot, "meeting_booked"), true, "hot: meeting_booked fires");
  eq(shouldNotifyForClass(hot, "qualifying_question"), true, "hot: qualifying_question fires");
  // referral is owner-facing (owner call 2026-08-31): the OWNER internal-automation
  // pings on it under "hot" (a handoff is a lead to chase), but the CLIENT hot-lead
  // email in the pipeline still excludes it (gated on HOT_REPLY_CLASSES, not this).
  eq(shouldNotifyForClass(hot, "referral_forward"), true, "hot: referral_forward fires for owner");
  eq(shouldNotifyForClass(hot, "not_interested"), false, "hot: not_interested silent");
  eq(shouldNotifyForClass(hot, "ooo"), false, "hot: ooo silent");
  eq(shouldNotifyForClass(hot, null), false, "hot: null class silent");
  eq(shouldNotifyForClass(all, "not_interested"), true, "all: not_interested fires");
  eq(shouldNotifyForClass(all, "ooo"), true, "all: ooo fires");
  eq(shouldNotifyForClass(all, null), true, "all: even null fires");
  // Triage override (R9): a hot-but-uncertain needs_review reply fires even under
  // "hot only", so the owner/VA is pinged to triage it fast.
  eq(shouldNotifyForClass(hot, "needs_review", { triage: true }), true, "hot+triage: needs_review fires");
  eq(shouldNotifyForClass(hot, "needs_review"), false, "hot: needs_review silent without triage");
}

// ── snippet ──────────────────────────────────────────────────────────────────
console.log("snippet");
eq(snippet(null), null, "null → null");
eq(snippet("   "), null, "whitespace → null");
eq(snippet("  hi\n\n there  "), "hi there", "collapses whitespace + trims");
{
  const long = "x".repeat(300);
  const s = snippet(long, 240)!;
  ok(s.length <= 240, "snippet capped at max length");
  ok(s.endsWith("…"), "snippet ellipsized when truncated");
}

// ── buildReplyEvent ──────────────────────────────────────────────────────────
console.log("buildReplyEvent");
const reply = {
  id: "r1",
  organization_id: "org1",
  client_id: "c1",
  campaign_id: "camp1",
  source_channel: "native_email",
  lead_email: "prospect@acme.com",
  lead_name: "Pat Prospect",
  lead_company: "Acme",
  from_address: "pat@acme.com",
  subject: "Re: quick question",
  body_text: "Yes, very interested, can we chat Thursday?",
  received_at: "2026-08-26T10:00:00.000Z",
} as unknown as LeadReply;
const client = { id: "c1", name: "Cabrera Co" } as unknown as Client;
{
  const ev = buildReplyEvent({ reply, client, finalClass: "true_interest" });
  eq(ev.kind, "reply", "kind reply");
  eq(ev.event_type, "reply.hot", "hot class → reply.hot");
  eq(ev.organization_id, "org1", "carries org id");
  eq(ev.client_name, "Cabrera Co", "carries client name");
  ok(ev.title.includes("Positive reply"), "hot title says Positive reply");
  ok(ev.title.includes("Pat Prospect"), "title uses lead name");
  eq(ev.reply?.from_address, "pat@acme.com", "reply from_address");
  eq(ev.reply?.snippet, "Yes, very interested, can we chat Thursday?", "reply snippet");
  eq(ev.node, null, "reply event has no node");

  const cold = buildReplyEvent({ reply, client, finalClass: "not_interested" });
  eq(cold.event_type, "reply.received", "non-hot class → reply.received");
  ok(cold.title.includes("New reply"), "non-hot title says New reply");

  const noClient = buildReplyEvent({ reply, client: null, finalClass: "true_interest" });
  eq(noClient.client_name, null, "null client → null client_name");
}

// ── renderSlackPayload ───────────────────────────────────────────────────────
console.log("renderSlackPayload");
{
  const ev = buildReplyEvent({ reply, client, finalClass: "true_interest" });
  const { text, blocks } = renderSlackPayload(ev);
  ok(text.includes("Positive reply"), "slack text has headline");
  ok(text.includes("pat@acme.com"), "slack text has from address");
  ok(text.includes("Yes, very interested"), "slack text has snippet");
  ok(Array.isArray(blocks) && blocks.length >= 1, "slack blocks present");
}

// ── renderWebhookBody ────────────────────────────────────────────────────────
console.log("renderWebhookBody");
{
  const ev = buildReplyEvent({ reply, client, finalClass: "meeting_booked" });
  const raw = renderWebhookBody(ev);
  const parsed = JSON.parse(raw);
  eq(parsed.event_type, "reply.hot", "webhook body has event_type");
  eq(parsed.reply.id, "r1", "webhook body has reply id");
  eq(parsed.organization_id, "org1", "webhook body has org id");
}

// ── renderEmail ──────────────────────────────────────────────────────────────
console.log("renderEmail");
{
  const ev = buildReplyEvent({ reply, client, finalClass: "true_interest" });
  const { subject, html } = renderEmail(ev);
  ok(subject.startsWith("[LeadStart]"), "email subject prefixed");
  ok(html.includes("Cabrera Co"), "email html has client");
  ok(html.includes("pat@acme.com"), "email html has from");
  ok(html.includes("Yes, very interested"), "email html has snippet");
}

// ── signBody ─────────────────────────────────────────────────────────────────
console.log("signBody");
{
  const a = signBody("body", "secret");
  const b = signBody("body", "secret");
  const c = signBody("body2", "secret");
  const d = signBody("body", "secret2");
  eq(a, b, "deterministic for same body+secret");
  eq(a.length, 64, "sha256 hex is 64 chars");
  ok(/^[0-9a-f]+$/.test(a), "hex output");
  ok(a !== c, "different body → different signature");
  ok(a !== d, "different secret → different signature");
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failures:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
