// The rules of follow-up alerts (campaigns.follow_up_alerts, migration 00142),
// kept pure so scripts/test-follow-up-alerts.ts runs without a database: what
// counts as a follow-up, which replies a pass alerts, and the owner email.
// Delivery is src/lib/replies/follow-up.ts.

import type { LeadReply, ReplyClass } from "@/types/app";
import { CLASS_META, cleanThreadBody } from "./ui";

/** Later replies of a conversation that came in this recently are swept up too. */
export const FOLLOW_UP_SWEEP_MS = 60 * 60 * 1000;
/** The email quotes at most this much of what they wrote. */
export const EMAIL_BODY_MAX = 3000;

export interface ConversationReply {
  id: string;
  received_at: string;
  created_at: string | null;
  follow_up_alerted_at: string | null;
}

function byArrival(a: ConversationReply, b: ConversationReply): number {
  return (
    Date.parse(a.received_at) - Date.parse(b.received_at) ||
    Date.parse(a.created_at ?? a.received_at) - Date.parse(b.created_at ?? b.received_at) ||
    a.id.localeCompare(b.id)
  );
}

/** True when `replyId` is not the first reply of its conversation. */
export function isFollowUp(rows: ConversationReply[], replyId: string): boolean {
  if (!rows.some((r) => r.id === replyId) || rows.length < 2) return false;
  return [...rows].sort(byArrival)[0].id !== replyId;
}

/**
 * The replies to alert now, while `replyId` is processed: every reply after the
 * conversation's first that hasn't been alerted, if it's this one or came in
 * within FOLLOW_UP_SWEEP_MS of `nowMs`. Oldest first.
 */
export function followUpsToAlert(rows: ConversationReply[], replyId: string, nowMs: number): string[] {
  if (rows.length < 2) return [];
  const [first, ...rest] = [...rows].sort(byArrival);
  return rest
    .filter((r) => r.id !== first.id && !r.follow_up_alerted_at)
    .filter((r) => {
      if (r.id === replyId) return true;
      const landed = Date.parse(r.created_at ?? r.received_at);
      return Number.isFinite(landed) && nowMs - landed <= FOLLOW_UP_SWEEP_MS;
    })
    .map((r) => r.id);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function classLabel(cls: ReplyClass | null): string {
  return cls ? CLASS_META[cls]?.label ?? cls : "Not read yet";
}

/** Who wrote: "Mark Lindquist (Lindquist Law)", else their address. */
export function followUpWho(r: Pick<LeadReply, "lead_name" | "lead_company" | "lead_email">): string {
  const name = r.lead_name?.trim() || r.lead_email || "A lead";
  return r.lead_company?.trim() ? `${name} (${r.lead_company.trim()})` : name;
}

/** The owner email for one follow-up. */
export function buildFollowUpEmail(args: {
  reply: Pick<
    LeadReply,
    "lead_name" | "lead_company" | "lead_email" | "subject" | "body_text" | "final_class" | "received_at"
  >;
  campaignName: string;
  clientName: string | null;
  inboxUrl: string;
}): { subject: string; html: string } {
  const { reply, campaignName, clientName, inboxUrl } = args;
  const who = followUpWho(reply);
  const subject = `Follow-up from ${who}: ${campaignName}`;
  let said = cleanThreadBody(reply.body_text).trim() || (reply.subject ?? "").trim();
  if (said.length > EMAIL_BODY_MAX) said = said.slice(0, EMAIL_BODY_MAX).replace(/\s+\S*$/, "") + "…";
  const rows: [string, string | null][] = [
    ["Campaign", campaignName],
    ["Client", clientName],
    ["From", reply.lead_email],
    ["Read as", classLabel(reply.final_class)],
    ["Subject", reply.subject],
  ];
  const rowsHtml = rows
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#555;">${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`,
    )
    .join("");
  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;max-width:640px;">
  <h2 style="margin:0 0 12px;color:#4f46e5;font-size:18px;">${escapeHtml(who)} wrote back</h2>
  ${said ? `<blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid #6366f1;background:#f5f5ff;color:#333;white-space:pre-wrap;">${escapeHtml(said)}</blockquote>` : ""}
  <table style="border-collapse:collapse;font-size:13px;margin-top:8px;">${rowsHtml}</table>
  <p style="margin:16px 0 0;"><a href="${escapeHtml(inboxUrl)}" style="display:inline-block;padding:8px 16px;border-radius:999px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;font-size:14px;">Open it in the Inbox</a></p>
  <p style="margin:16px 0 0;color:#888;font-size:12px;">Follow-up alerts are on for this campaign (its Setup tab).</p>
</div>`.trim();
  return { subject, html };
}
