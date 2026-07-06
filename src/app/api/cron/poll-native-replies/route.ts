// GET /api/cron/poll-native-replies
//
// Inbound tick for the native email channel. Polls each Google mailbox's
// inbox for new mail, matches it back to a native_sends thread, and:
//   - Bounces (DSNs from mailer-daemon) → flip the contact to 'bounced',
//     mark the send row bounced, fail the enrollment. No lead_replies row.
//   - Human replies → upsert a lead_replies row (source_channel=
//     'native_email') and run the existing classifier + hot-lead
//     notification pipeline inline. Stop the sequence (enrollment='replied')
//     unless the message is an auto-reply (OOO), which must NOT halt it.
//
// Matching is by Gmail threadId only: a reply to our email carries the same
// threadId as the original send, so we look up native_sends by
// (mailbox_id, gmail_thread_id). Anything without a thread match is
// non-campaign mail and is dropped silently — the poller never ingests
// arbitrary inbox mail.
//
// Not gated by the send window: replies and bounces arrive at any hour.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { runReplyPipeline } from "@/lib/replies/pipeline";
import { GmailClient, GmailConfigError } from "@/lib/gmail/client";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { parseGmailMessage, isBounce, bounceSeverity, isAutoSubmitted, extractFailedRecipient } from "@/lib/gmail/mime";
import { escapeLikePattern } from "@/lib/utils";
import type { NativeMailbox } from "@/types/app";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAILBOXES_PER_TICK = 10;
// Global budget across all mailboxes this tick. Classification is now
// deterministic keyword matching (no model call), so each message is cheap;
// the cap mainly bounds Gmail API calls per run. Runs every minute.
const MAX_MESSAGES_PER_TICK = 40;
// Re-read window overlap. Dedup on (organization_id, gmail_message_id) makes
// re-reading the last few minutes of mail harmless.
const OVERLAP_MS = 5 * 60 * 1000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // first poll of a never-polled mailbox

type SendRow = {
  id: string;
  organization_id: string;
  campaign_id: string;
  contact_id: string;
  enrollment_id: string | null;
  to_email: string;
  status: string;
};

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  const { data: mbData, error: mbError } = await admin
    .from("native_mailboxes")
    .select("*")
    // Poll active + paused (a paused inbox still receives replies/bounces);
    // skip 'error' — its delegation is broken, so reads would just fail.
    .in("status", ["active", "paused"])
    .order("last_polled_at", { ascending: true, nullsFirst: true })
    .limit(MAILBOXES_PER_TICK);
  if (mbError) {
    console.error("[cron/native-replies] mailbox fetch failed:", mbError);
    return NextResponse.json({ error: mbError.message }, { status: 500 });
  }
  const mailboxes = (mbData ?? []) as NativeMailbox[];
  if (mailboxes.length === 0) return NextResponse.json({ status: "idle" });

  const gmailByOrg = new Map<string, GmailClient | null>();
  const clientIdByCampaign = new Map<string, string | null>();
  let processed = 0;
  const summary = { replies: 0, bounces: 0, dropped: 0 };

  for (const mailbox of mailboxes) {
    if (processed >= MAX_MESSAGES_PER_TICK) break;

    // Per-mailbox try/catch: one broken delegation must not stall the pool.
    try {
      if (!gmailByOrg.has(mailbox.organization_id)) {
        try {
          gmailByOrg.set(mailbox.organization_id, await loadGmailClientForOrg(admin, mailbox.organization_id));
        } catch (err) {
          gmailByOrg.set(mailbox.organization_id, null);
          if (!(err instanceof GmailConfigError)) {
            console.error("[cron/native-replies] gmail client load failed:", err);
          }
        }
      }
      const gmail = gmailByOrg.get(mailbox.organization_id);
      if (!gmail) continue;

      const tickStart = Date.now();
      const watermark = mailbox.last_polled_at
        ? Date.parse(mailbox.last_polled_at) - OVERLAP_MS
        : Date.now() - LOOKBACK_MS;
      const afterSec = Math.floor(watermark / 1000);

      const listed = await gmail.listMessages(mailbox.email_address, `in:inbox after:${afterSec}`, 25);

      for (const entry of listed) {
        if (processed >= MAX_MESSAGES_PER_TICK) break;

        const msg = await gmail.getMessage(mailbox.email_address, entry.id, "full");
        const parsed = parseGmailMessage(msg);
        const fromEmail = extractEmail(parsed.from);

        // Skip our own mail (shouldn't appear under in:inbox, but be safe).
        if (fromEmail && fromEmail === mailbox.email_address.toLowerCase()) continue;

        // Match the inbound thread to a send from this mailbox.
        const { data: sendData } = await admin
          .from("native_sends")
          .select("id, organization_id, campaign_id, contact_id, enrollment_id, to_email, status")
          .eq("mailbox_id", mailbox.id)
          .eq("gmail_thread_id", msg.threadId)
          .order("sent_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const sendRow = sendData as SendRow | null;

        // ---- Bounce branch ----
        if (isBounce(parsed)) {
          // Only permanent (hard) bounces suppress. A soft bounce is a
          // transient failure Gmail retries on its own; suppressing on it
          // would wrongly kill a reachable lead. Ignore soft bounces —
          // a persistent one arrives later as a hard DSN.
          if (bounceSeverity(parsed) === "soft") {
            processed++;
            continue;
          }
          const recipient = sendRow?.to_email ?? extractFailedRecipient(parsed);
          const reason = (parsed.subject ?? "Delivery failure").slice(0, 300);
          if (sendRow) {
            if (sendRow.status !== "bounced") {
              await admin
                .from("native_sends")
                .update({ status: "bounced", bounce_reason: reason, bounced_at: new Date().toISOString() })
                .eq("id", sendRow.id);
            }
            await admin.from("contacts").update({ status: "bounced" }).eq("id", sendRow.contact_id);
            if (sendRow.enrollment_id) {
              await admin
                .from("campaign_enrollments")
                .update({ status: "failed", last_error: "Hard bounce" })
                .eq("id", sendRow.enrollment_id);
            }
          } else if (recipient) {
            // No thread match but we know who bounced — suppress by email.
            await admin
              .from("contacts")
              .update({ status: "bounced" })
              .eq("organization_id", mailbox.organization_id)
              .ilike("email", escapeLikePattern(recipient));
          }
          processed++;
          summary.bounces++;
          continue;
        }

        // ---- Reply branch ----
        if (!sendRow) {
          // Not a reply to any of our campaign sends — ignore.
          summary.dropped++;
          continue;
        }

        // Resolve the campaign's client_id (cached).
        if (!clientIdByCampaign.has(sendRow.campaign_id)) {
          const { data: camp } = await admin
            .from("campaigns")
            .select("client_id")
            .eq("id", sendRow.campaign_id)
            .maybeSingle();
          clientIdByCampaign.set(sendRow.campaign_id, (camp as { client_id: string | null } | null)?.client_id ?? null);
        }
        const clientId = clientIdByCampaign.get(sendRow.campaign_id) ?? null;

        // Stop-on-reply — but never on an auto-reply (OOO), which would
        // wrongly halt the sequence. Human reply → halt + mark replied.
        if (!isAutoSubmitted(parsed)) {
          if (sendRow.enrollment_id) {
            await admin
              .from("campaign_enrollments")
              .update({ status: "replied" })
              .eq("id", sendRow.enrollment_id)
              .eq("status", "active");
          }
          await admin
            .from("contacts")
            .update({ status: "replied" })
            .eq("id", sendRow.contact_id)
            .neq("status", "bounced")
            .neq("status", "unsubscribed");
        }

        const leadEmail = fromEmail || sendRow.to_email;
        const row = {
          organization_id: mailbox.organization_id,
          client_id: clientId,
          campaign_id: sendRow.campaign_id,
          source_channel: "native_email" as const,
          gmail_message_id: entry.id,
          gmail_thread_id: msg.threadId,
          native_mailbox_id: mailbox.id,
          lead_email: leadEmail,
          lead_name: extractDisplayName(parsed.from),
          from_address: fromEmail,
          to_address: mailbox.email_address,
          subject: parsed.subject,
          body_text: parsed.bodyText,
          body_html: parsed.bodyHtml,
          received_at: parsed.internalDateMs ? new Date(parsed.internalDateMs).toISOString() : new Date().toISOString(),
          raw_payload: {
            gmail_message_id: entry.id,
            thread_id: msg.threadId,
            snippet: msg.snippet ?? null,
            from: parsed.from,
            subject: parsed.subject,
          } as Record<string, unknown>,
          status: "new" as const,
        };

        const { data: upserted, error: upsertError } = await admin
          .from("lead_replies")
          .upsert(row, { onConflict: "organization_id,gmail_message_id", ignoreDuplicates: false })
          .select("id")
          .single();
        if (upsertError || !upserted) {
          console.error("[cron/native-replies] lead_replies upsert failed:", upsertError);
          continue;
        }

        // Classify + notify inline (we're in a cron, not a webhook — no
        // after() to defer to; the pipeline is idempotent on final_class).
        try {
          await runReplyPipeline((upserted as { id: string }).id, admin);
        } catch (err) {
          console.error("[cron/native-replies] runReplyPipeline threw:", err);
        }
        processed++;
        summary.replies++;
      }

      // Advance the watermark only after the mailbox is fully processed.
      await admin
        .from("native_mailboxes")
        .update({ last_polled_at: new Date(tickStart).toISOString() })
        .eq("id", mailbox.id);
    } catch (err) {
      console.error(`[cron/native-replies] mailbox ${mailbox.email_address} failed:`, err);
      // Leave last_polled_at unchanged so the next tick retries this window.
    }
  }

  return NextResponse.json({ status: "ok", processed, ...summary });
}

// Pull the bare email out of a "Name <email>" header (or a raw address).
function extractEmail(header: string | null): string | null {
  if (!header) return null;
  const angle = header.match(/<([^>]+)>/);
  const raw = (angle ? angle[1] : header).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(raw) ? raw : null;
}

// Pull the display name out of a "Name <email>" header, if present.
function extractDisplayName(header: string | null): string | null {
  if (!header) return null;
  const m = header.match(/^\s*"?([^"<]+?)"?\s*</);
  const name = m ? m[1].trim() : null;
  return name || null;
}
