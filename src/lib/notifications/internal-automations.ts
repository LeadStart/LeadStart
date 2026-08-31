// Internal automations — delivery.
//
// The "internal automation" surface behind the Flow builder's kind:'internal'
// nodes has two delivery paths:
//
//   1. EVENT-TRIGGERED (live today) — deliverReplyAutomations() runs from the
//      reply pipeline when an inbound reply is classified. It fans an org's
//      configured targets (Slack incoming webhook / generic outbound webhook /
//      teammate email) out with a compact event. No graph runtime needed, so it
//      ships in parallel with the branch-execution work.
//
//   2. INLINE NODES (future) — runInternalNode() is the exported hook the graph
//      runtime will call when the sender reaches a kind:'internal' node mid-
//      sequence. It reuses the same org targets + fan-out. It is NOT wired into
//      run-native-sequences yet (that's the separate graph-runtime session); see
//      the TODO at the bottom of this file.
//
// Delivery is best-effort by design (owner call — "simpler over defensive"): a
// lost Slack ping on a rare Slack/webhook outage is cheap, and the reliable
// hot-lead *email* still fires via the client notification path. Every channel
// is wrapped + logged; a failure in one never blocks the others or the caller.

import { createHmac } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import type {
  AutomationSettings,
  Client,
  LeadReply,
  ReplyClass,
} from "@/types/app";
import { HOT_REPLY_CLASSES, OWNER_NOTIFY_HOT_CLASSES } from "@/types/app";
import type { FlowInternalAction } from "@/lib/flow/graph";
import { loadAutomationSettings } from "@/lib/automations/settings";
import {
  sendViaResend,
  MissingResendKeyError,
} from "./resend-client";

type Admin = ReturnType<typeof createAdminClient>;

// How long we give a Slack/webhook POST before abandoning it. Short: this runs
// inside the reply pipeline's after() and must not park the function.
const OUTBOUND_TIMEOUT_MS = 6000;

// ── Event shape ───────────────────────────────────────────────────────────

/**
 * A normalized automation event — the single payload every channel renders
 * from. Represents either a classified reply (kind: "reply", live path) or an
 * inline graph node the sender reached (kind: "internal_node", future path).
 */
export interface AutomationEvent {
  kind: "reply" | "internal_node";
  // Machine event type: "reply.hot" | "reply.received" | "node.notify" | "node.webhook".
  event_type: string;
  // Human one-line headline (Slack title / email subject).
  title: string;
  occurred_at: string;
  organization_id: string;
  client_id: string | null;
  client_name: string | null;
  campaign_id: string | null;
  // Reply-trigger detail (null on node events).
  reply: {
    id: string;
    final_class: ReplyClass | null;
    source_channel: string;
    from_address: string | null;
    lead_name: string | null;
    lead_company: string | null;
    subject: string | null;
    snippet: string | null;
    received_at: string;
  } | null;
  // Inline-node detail (null on reply events).
  node: {
    id: string;
    action: FlowInternalAction;
    label: string;
    target: string | null;
    campaign_id: string | null;
    contact_id: string | null;
  } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Collapse whitespace + cap length for a preview snippet. */
export function snippet(text: string | null | undefined, max = 240): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Whether an org configured to fire on `notify_on` should notify for this class. */
export function shouldNotifyForClass(
  settings: AutomationSettings,
  finalClass: ReplyClass | null,
  opts?: { triage?: boolean },
): boolean {
  // A hot-but-uncertain reply (classifier parked it in needs_review but there
  // was a hot signal underneath) is owner-triage-worthy regardless of the
  // notify_on gate, so surface it even when the org set "hot only".
  if (opts?.triage) return true;
  if (settings.notify_on === "all_replies") return true;
  // "hot": positive replies PLUS referrals. This is the owner channel, so a
  // handoff (owner-facing, never client-emailed) is still worth an owner ping.
  return !!finalClass && OWNER_NOTIFY_HOT_CLASSES.includes(finalClass);
}

/** HMAC-SHA256 of the raw body with the shared secret, hex-encoded. */
export function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

// ── Renders (pure, unit-tested) ─────────────────────────────────────────────

const CLASS_LABEL: Partial<Record<ReplyClass, string>> = {
  true_interest: "Interested",
  meeting_booked: "Meeting booked",
  qualifying_question: "Qualifying question",
  referral_forward: "Referral / forward",
  objection_price: "Objection — price",
  objection_timing: "Objection — timing",
  not_interested: "Not interested",
  wrong_person_no_referral: "Wrong person",
  ooo: "Out of office",
  unsubscribe: "Unsubscribe",
  needs_review: "Needs review",
};

function classLabel(c: ReplyClass | null): string {
  return (c && CLASS_LABEL[c]) || c || "unclassified";
}

/** Slack incoming-webhook payload. Plain text + a context section. */
export function renderSlackPayload(event: AutomationEvent): {
  text: string;
  blocks: unknown[];
} {
  const lines: string[] = [];
  const contextBits: string[] = [];
  if (event.client_name) contextBits.push(event.client_name);

  if (event.reply) {
    const who =
      event.reply.lead_name?.trim() ||
      event.reply.from_address ||
      "Unknown sender";
    const from = event.reply.from_address ? ` <${event.reply.from_address}>` : "";
    const company = event.reply.lead_company ? ` · ${event.reply.lead_company}` : "";
    lines.push(`*${who}*${from}${company}`);
    if (event.reply.subject) lines.push(`_${event.reply.subject}_`);
    if (event.reply.snippet) lines.push(`> ${event.reply.snippet}`);
    contextBits.push(classLabel(event.reply.final_class));
    contextBits.push(event.reply.source_channel);
  } else if (event.node) {
    if (event.node.label) lines.push(event.node.label);
    if (event.node.target) lines.push(`Target: ${event.node.target}`);
    contextBits.push(`automation: ${event.node.action}`);
  }

  const text = `${event.title}${lines.length ? `\n${lines.join("\n")}` : ""}`;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: text } },
  ];
  if (contextBits.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contextBits.join("  ·  ") }],
    });
  }
  return { text, blocks };
}

/** Generic outbound-webhook JSON body. The whole event, stable-shaped. */
export function renderWebhookBody(event: AutomationEvent): string {
  return JSON.stringify(event);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Teammate-notification email (subject + html). */
export function renderEmail(event: AutomationEvent): {
  subject: string;
  html: string;
} {
  const subject = `[LeadStart] ${event.title}`;
  const rows: [string, string | null][] = [];
  if (event.client_name) rows.push(["Client", event.client_name]);
  if (event.reply) {
    rows.push(["From", event.reply.from_address]);
    rows.push(["Name", event.reply.lead_name]);
    rows.push(["Company", event.reply.lead_company]);
    rows.push(["Class", classLabel(event.reply.final_class)]);
    rows.push(["Channel", event.reply.source_channel]);
    rows.push(["Subject", event.reply.subject]);
  } else if (event.node) {
    rows.push(["Automation", event.node.action]);
    rows.push(["Label", event.node.label || null]);
    rows.push(["Target", event.node.target]);
  }
  const rowsHtml = rows
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#555;">${escapeHtml(k)}</td>` +
        `<td>${escapeHtml(String(v))}</td></tr>`,
    )
    .join("");
  const body = event.reply?.snippet
    ? `<blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid #6366f1;background:#f5f5ff;color:#333;">${escapeHtml(
        event.reply.snippet,
      )}</blockquote>`
    : "";
  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;max-width:640px;">
  <h2 style="margin:0 0 12px;color:#4f46e5;font-size:18px;">${escapeHtml(event.title)}</h2>
  ${body}
  ${rowsHtml ? `<table style="border-collapse:collapse;font-size:13px;margin-top:8px;">${rowsHtml}</table>` : ""}
  <p style="margin:16px 0 0;color:#888;font-size:12px;">Sent by a LeadStart internal automation.</p>
</div>`.trim();
  return { subject, html };
}

// ── Event builders ──────────────────────────────────────────────────────────

/** Build the automation event for a classified inbound reply. */
export function buildReplyEvent(args: {
  reply: LeadReply;
  client: Client | null;
  finalClass: ReplyClass | null;
  triage?: boolean;
}): AutomationEvent {
  const { reply, client, finalClass, triage } = args;
  const isHot = !!finalClass && HOT_REPLY_CLASSES.includes(finalClass);
  const isReferral = finalClass === "referral_forward";
  const who =
    reply.lead_name?.trim() || reply.from_address || reply.lead_email || "a lead";
  const title = triage
    ? `Reply needs a look from ${who}`
    : isReferral
    ? `Referral from ${who}`
    : isHot
    ? `Positive reply from ${who}`
    : `New reply from ${who}`;
  return {
    kind: "reply",
    event_type: triage
      ? "reply.needs_review"
      : isReferral
      ? "reply.referral"
      : isHot
      ? "reply.hot"
      : "reply.received",
    title,
    occurred_at: new Date().toISOString(),
    organization_id: reply.organization_id,
    client_id: reply.client_id,
    client_name: client?.name ?? null,
    campaign_id: reply.campaign_id,
    reply: {
      id: reply.id,
      final_class: finalClass,
      source_channel: reply.source_channel,
      from_address: reply.from_address ?? reply.lead_email ?? null,
      lead_name: reply.lead_name,
      lead_company: reply.lead_company,
      subject: reply.subject,
      snippet: snippet(reply.body_text),
      received_at: reply.received_at,
    },
    node: null,
  };
}

// ── Fan-out ───────────────────────────────────────────────────────────────

export interface AutomationChannelResult {
  channel: "slack" | "webhook" | "email";
  ok: boolean;
  skippedReason?: string;
  error?: string;
}

export interface AutomationDeliveryResult {
  delivered: boolean; // true if at least one channel succeeded
  results: AutomationChannelResult[];
  skippedReason?: string; // populated when nothing was attempted
}

async function postJson(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan an event out to every configured channel, best-effort. Each channel is
 * independent — one failing never blocks another. Never throws.
 */
export async function fanOutAutomation(
  settings: AutomationSettings,
  event: AutomationEvent,
): Promise<AutomationDeliveryResult> {
  const results: AutomationChannelResult[] = [];

  // Slack incoming webhook.
  if (settings.slack_webhook_url) {
    try {
      const { text, blocks } = renderSlackPayload(event);
      await postJson(settings.slack_webhook_url, JSON.stringify({ text, blocks }), {});
      results.push({ channel: "slack", ok: true });
    } catch (err) {
      console.error("[internal-automations] Slack delivery failed:", err);
      results.push({
        channel: "slack",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Generic outbound webhook (optionally HMAC-signed).
  if (settings.outbound_webhook_url) {
    try {
      const rawBody = renderWebhookBody(event);
      const headers: Record<string, string> = { "X-LeadStart-Event": event.event_type };
      if (settings.outbound_webhook_secret) {
        headers["X-LeadStart-Signature"] = `sha256=${signBody(
          rawBody,
          settings.outbound_webhook_secret,
        )}`;
      }
      await postJson(settings.outbound_webhook_url, rawBody, headers);
      results.push({ channel: "webhook", ok: true });
    } catch (err) {
      console.error("[internal-automations] Webhook delivery failed:", err);
      results.push({
        channel: "webhook",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Teammate email (Resend).
  if (settings.notify_email) {
    try {
      const { subject, html } = renderEmail(event);
      const from = process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>";
      await sendViaResend({ from, to: settings.notify_email, subject, html });
      results.push({ channel: "email", ok: true });
    } catch (err) {
      if (err instanceof MissingResendKeyError) {
        results.push({ channel: "email", ok: false, skippedReason: "missing_resend_key" });
      } else {
        console.error("[internal-automations] Email delivery failed:", err);
        results.push({
          channel: "email",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    delivered: results.some((r) => r.ok),
    results,
    skippedReason: results.length === 0 ? "no_targets_configured" : undefined,
  };
}

// ── Live path: reply pipeline ───────────────────────────────────────────────

/**
 * Event-triggered delivery for a classified inbound reply. Called (best-effort)
 * from runReplyPipeline after the classification is written. Loads the org's
 * automation settings, gates on enabled + notify_on, and fans out. Never throws
 * — returns a structured result the pipeline logs.
 *
 * Independent of the per-client hot-lead email path: an org's Slack/webhook ping
 * fires even when the client has no notification_email configured.
 */
export async function deliverReplyAutomations(args: {
  admin: Admin;
  organizationId: string;
  reply: LeadReply;
  client: Client | null;
  finalClass: ReplyClass | null;
  // Set when the reply is hot-but-uncertain (parked in needs_review with a hot
  // signal underneath): fires the owner ping even under a "hot only" notify_on,
  // and flavors the event as a triage prompt rather than a positive reply.
  triage?: boolean;
}): Promise<AutomationDeliveryResult> {
  const { admin, organizationId, reply, client, finalClass, triage } = args;
  try {
    const settings = await loadAutomationSettings(admin, organizationId);
    if (!settings.enabled) {
      return { delivered: false, results: [], skippedReason: "disabled" };
    }
    if (!shouldNotifyForClass(settings, finalClass, { triage })) {
      return { delivered: false, results: [], skippedReason: "class_not_in_notify_on" };
    }
    const hasTarget =
      settings.slack_webhook_url || settings.outbound_webhook_url || settings.notify_email;
    if (!hasTarget) {
      return { delivered: false, results: [], skippedReason: "no_targets_configured" };
    }
    const event = buildReplyEvent({ reply, client, finalClass, triage });
    return await fanOutAutomation(settings, event);
  } catch (err) {
    // Fully swallow — a broken automation path must never break the pipeline.
    console.error("[internal-automations] deliverReplyAutomations failed:", err);
    return {
      delivered: false,
      results: [],
      skippedReason: "delivery_error",
    };
  }
}

// ── FUTURE HOOK: inline graph internal-nodes ────────────────────────────────
//
// TODO(graph-runtime): This is the single entry point the branch-execution /
// graph runtime should call when the native sender reaches a kind:'internal'
// node mid-sequence (src/lib/flow/graph.ts → InternalNode). It is intentionally
// NOT wired into run-native-sequences/route.ts or the campaign_enrollments model
// yet — that belongs to the separate graph-runtime session. When that lands:
//
//   1. In the sender's per-enrollment step loop, when the next node is
//      kind:'internal', call runInternalNode(node, { admin, organizationId,
//      campaignId, contactId, clientName? }) instead of skipping it, then
//      advance the enrollment past the node.
//   2. Keep it best-effort (same contract as the reply path) so a failed ping
//      never stalls the sequence.
//
// The 'notify' and 'webhook' actions are implemented here already (they reuse
// the org's automation targets), so wiring is just the call site above. The
// 'task' action is a stub: creating a VA task belongs to the LinkedIn VA-task
// inbox work (migration 00088) — delegate to that once it exists.

export interface InternalNodeContext {
  admin: Admin;
  organizationId: string;
  campaignId: string | null;
  contactId: string | null;
  clientId?: string | null;
  clientName?: string | null;
}

export async function runInternalNode(
  node: {
    id: string;
    action: FlowInternalAction;
    label: string;
    target?: string;
  },
  ctx: InternalNodeContext,
): Promise<AutomationDeliveryResult> {
  try {
    const settings = await loadAutomationSettings(ctx.admin, ctx.organizationId);

    // 'task' → a VA task, not a notification. Owned by the VA-task inbox work
    // (migration 00088). Until that ships, this is a no-op we log.
    if (node.action === "task") {
      console.warn(
        `[internal-automations] runInternalNode: 'task' action not implemented yet ` +
          `(node ${node.id} "${node.label}") — pending the VA-task inbox (migration 00088).`,
      );
      return { delivered: false, results: [], skippedReason: "task_not_implemented" };
    }

    if (!settings.enabled) {
      return { delivered: false, results: [], skippedReason: "disabled" };
    }

    const event: AutomationEvent = {
      kind: "internal_node",
      event_type: node.action === "webhook" ? "node.webhook" : "node.notify",
      title: node.label?.trim() || `Automation: ${node.action}`,
      occurred_at: new Date().toISOString(),
      organization_id: ctx.organizationId,
      client_id: ctx.clientId ?? null,
      client_name: ctx.clientName ?? null,
      campaign_id: ctx.campaignId,
      reply: null,
      node: {
        id: node.id,
        action: node.action,
        label: node.label,
        target: node.target ?? null,
        campaign_id: ctx.campaignId,
        contact_id: ctx.contactId,
      },
    };
    return await fanOutAutomation(settings, event);
  } catch (err) {
    console.error("[internal-automations] runInternalNode failed:", err);
    return { delivered: false, results: [], skippedReason: "delivery_error" };
  }
}
