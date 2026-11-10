// Follow-up alerts, per campaign (campaigns.follow_up_alerts, migration 00142).
// Daniel, 2026-11-09: "ANY follow-up response thereafter needs to give us a
// notification if we choose so for certain campaigns." Owner picks the same day:
// a phone push plus an email to the owner logins; anything after the lead's
// first reply counts; on for TuBe and PolishPoint.
//
// A follow-up is any message after the first reply of a conversation: the same
// Gmail thread, or the same sender in the same campaign (a reply Gmail filed in
// a thread of its own). Auto-replies count. With the campaign's switch on, each
// one alerts whatever the classifier called it, and the reply pipeline skips
// its own hot / review push for it, so a hot follow-up pings once.
//
// The poller may process two messages of one conversation in the same tick, the
// newer first (Gmail's listing order is unspecified). So when a reply is
// processed, every later reply of its conversation that came in within the
// last hour and wasn't alerted is alerted too. follow_up_alerted_at is claimed
// atomically before anything is sent, so nothing alerts twice.
//
// Self-guarded: it never throws, and a database without migration 00142 just
// reads as "off" (the pipeline's usual alerts run).

import type { createAdminClient } from "@/lib/supabase/admin";
import type { LeadReply } from "@/types/app";
import { escapeLikePattern } from "@/lib/utils";
import {
  buildFollowUpEmail,
  classLabel,
  followUpWho,
  followUpsToAlert,
  isFollowUp,
  type ConversationReply,
} from "./follow-up-rules";
import { sendHotLeadPush } from "@/lib/notifications/web-push";
import { enqueueOwnerAlert, getOwnerRecipients } from "@/lib/notifications/owner-alerts";
import { sendViaResend, MissingResendKeyError } from "@/lib/notifications/resend-client";

type Admin = ReturnType<typeof createAdminClient>;

async function conversationOf(admin: Admin, reply: LeadReply): Promise<ConversationReply[] | null> {
  const cols = "id, received_at, created_at, follow_up_alerted_at";
  const found = new Map<string, ConversationReply>();
  const lookups = [];
  if (reply.gmail_thread_id) {
    lookups.push(
      admin
        .from("lead_replies")
        .select(cols)
        .eq("organization_id", reply.organization_id)
        .eq("campaign_id", reply.campaign_id!)
        .eq("gmail_thread_id", reply.gmail_thread_id)
        .limit(200),
    );
  }
  if (reply.lead_email) {
    lookups.push(
      admin
        .from("lead_replies")
        .select(cols)
        .eq("organization_id", reply.organization_id)
        .eq("campaign_id", reply.campaign_id!)
        .ilike("lead_email", escapeLikePattern(reply.lead_email))
        .limit(200),
    );
  }
  for (const { data, error } of await Promise.all(lookups)) {
    if (error) {
      console.error("[follow-up] conversation read failed:", error.message);
      return null;
    }
    for (const r of (data ?? []) as ConversationReply[]) found.set(r.id, r);
  }
  return [...found.values()];
}

async function sendOne(
  admin: Admin,
  replyId: string,
  campaignName: string,
  clientName: string | null,
): Promise<void> {
  // Claim first: only the run that stamps the row sends its alert.
  const { data: claimed, error } = await admin
    .from("lead_replies")
    .update({ follow_up_alerted_at: new Date().toISOString() })
    .eq("id", replyId)
    .is("follow_up_alerted_at", null)
    .select("*")
    .maybeSingle();
  if (error) {
    console.error("[follow-up] claim failed:", error.message);
    return;
  }
  if (!claimed) return;
  const reply = claimed as unknown as LeadReply;

  await sendHotLeadPush({
    admin,
    organizationId: reply.organization_id,
    replyId: reply.id,
    leadName: reply.lead_name,
    leadCompany: reply.lead_company,
    replySubject: reply.subject,
    replyBodyText: reply.body_text,
    finalClass: reply.final_class ?? "needs_review",
    kind: "follow_up",
  });

  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://leadstart-ebon.vercel.app/app").replace(/\/+$/, "");
  const { subject, html } = buildFollowUpEmail({
    reply,
    campaignName,
    clientName,
    inboxUrl: `${base}/admin/inbox/${reply.id}`,
  });
  const to = await getOwnerRecipients(admin);
  if (to.length === 0) return;
  try {
    const from = process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>";
    await sendViaResend({ from, to, subject, html });
  } catch (err) {
    if (err instanceof MissingResendKeyError) return;
    // The 5-minute owner digest retries what the direct email couldn't send.
    console.error("[follow-up] owner email failed; queued for the digest:", err);
    await enqueueOwnerAlert({
      admin,
      kind: "lead_follow_up",
      subject,
      summary: `${followUpWho(reply)} wrote back on ${campaignName} (${classLabel(reply.final_class)}).`,
      context: { reply_id: reply.id, campaign: campaignName, from: reply.lead_email },
    });
  }
}

/**
 * Alert the follow-ups of this reply's conversation, when its campaign has
 * follow-up alerts on. Returns true when this reply is itself a follow-up in
 * such a campaign (alerted now or already), so the caller skips its own push.
 * Never throws.
 */
export async function alertFollowUps(admin: Admin, reply: LeadReply): Promise<boolean> {
  try {
    if (!reply.campaign_id) return false;
    const { data: camp, error } = await admin
      .from("campaigns")
      .select("name, follow_up_alerts, client:client_id(name)")
      .eq("id", reply.campaign_id)
      .maybeSingle();
    if (error) {
      // A database without migration 00142 reads as off.
      if (!/follow_up_alerts/.test(error.message)) console.error("[follow-up] campaign read failed:", error.message);
      return false;
    }
    const campaign = camp as { name: string; follow_up_alerts: boolean; client: { name: string } | null } | null;
    if (!campaign?.follow_up_alerts) return false;

    const rows = await conversationOf(admin, reply);
    if (!rows) return false;
    if (!rows.some((r) => r.id === reply.id)) {
      rows.push({
        id: reply.id,
        received_at: reply.received_at,
        created_at: reply.created_at ?? null,
        follow_up_alerted_at: reply.follow_up_alerted_at ?? null,
      });
    }
    for (const id of followUpsToAlert(rows, reply.id, Date.now())) {
      await sendOne(admin, id, campaign.name, campaign.client?.name ?? null);
    }
    return isFollowUp(rows, reply.id);
  } catch (err) {
    console.error("[follow-up] alertFollowUps failed (non-fatal):", err);
    return false;
  }
}
