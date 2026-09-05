// GET /api/cron/poll-native-replies
//
// Inbound tick for the native email channel. Polls each Google mailbox's
// inbox for new mail, matches it back to a native_sends thread, and:
//   - Bounces (DSNs from mailer-daemon) → flip the contact to 'bounced',
//     mark the send row bounced, fail the enrollment. No lead_replies row.
//   - Human replies → insert a lead_replies row (source_channel=
//     'native_email') and run the existing classifier + hot-lead
//     notification pipeline inline. Stop the sequence (enrollment='replied')
//     unless the message is an auto-reply (OOO), which must NOT halt it.
//
// Matching is by Gmail threadId only: a reply to our email carries the same
// threadId as the original send, so we look up native_sends by
// (mailbox_id, gmail_thread_id). Anything without a thread match is
// non-campaign mail and is dropped silently: the poller never ingests
// arbitrary inbox mail.
//
// Not gated by the send window: replies and bounces arrive at any hour.
//
// Watermark discipline (SEND_RUNTIME_AUDIT.md SEND-01): a mailbox's
// last_polled_at only advances when its listing was read COMPLETELY. Gmail's
// docs leave list ordering unspecified and a page is capped, so a truncated
// listing (page bound, fetch cap, or the wall-clock guard) leaves the
// watermark where it was and the next tick re-reads the window; dedup on
// (organization_id, gmail_message_id) makes the re-read harmless.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { runReplyPipeline } from "@/lib/replies/pipeline";
import { GmailClient, GmailConfigError } from "@/lib/gmail/client";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { parseGmailMessage, isBounce, bounceSeverity, isAutoSubmitted, extractFailedRecipient } from "@/lib/gmail/mime";
import { escapeLikePattern } from "@/lib/utils";
import { shouldTripCircuitBreaker, enterTimers, CB_RATE_SAMPLE } from "@/lib/deliverability/lifecycle";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import type { NativeMailbox } from "@/types/app";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAILBOXES_PER_TICK = 10;
// Global budget of MATCHED messages (replies + bounces) across all mailboxes
// this tick. Each reply runs the two-layer classifier inline (deterministic
// prefilter + one Claude Haiku call, see src/lib/replies/pipeline.ts), so this
// also bounds model spend per minute. Runs every minute.
const MAX_MESSAGES_PER_TICK = 40;
// Global budget of Gmail message FETCHES (matched or not) this tick. The old
// budget counted only matched mail, so a spam-heavy pool could burn 250
// sequential Gmail calls and outrun the 60s function (SEND-16).
const MAX_FETCH_PER_TICK = 150;
// Stop starting new work after this long so the tick returns cleanly.
const TICK_DEADLINE_MS = 45_000;
// Listing: page size and how many pages one mailbox may walk per tick.
const LIST_PAGE_SIZE = 50;
const LIST_MAX_PAGES = 4;
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
  const tickDeadline = Date.now() + TICK_DEADLINE_MS;

  const { data: mbData, error: mbError } = await admin
    .from("native_mailboxes")
    .select("*")
    // Poll active + paused (a paused inbox still receives replies/bounces);
    // skip 'error': its delegation is broken, so reads would just fail.
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
  // campaign_id -> { client_id, the client's notification inbox }. A reply-all
  // from the client's own notification address on one of our threads is the
  // CLIENT talking, not the lead (SEND-09); it must never become a lead reply
  // or a DNC entry for the client's own address.
  const clientByCampaign = new Map<string, { clientId: string | null; notificationEmail: string | null }>();
  let processed = 0;
  let fetched = 0;
  const summary = { replies: 0, bounces: 0, softBounces: 0, dropped: 0, duplicates: 0, errors: 0, truncated: 0 };
  // Domains that took a HARD bounce this tick: evaluated once each, after the
  // loop, by the bounce circuit breaker (fast burn-prevention: a burst of hard
  // bounces tires the domain within a minute, ahead of the hourly health rollup).
  const bouncedDomains = new Set<string>();

  const resolveClient = async (campaignId: string) => {
    let entry = clientByCampaign.get(campaignId);
    if (entry) return entry;
    const { data: camp } = await admin
      .from("campaigns")
      .select("client_id")
      .eq("id", campaignId)
      .maybeSingle();
    const clientId = (camp as { client_id: string | null } | null)?.client_id ?? null;
    let notificationEmail: string | null = null;
    if (clientId) {
      const { data: cl } = await admin
        .from("clients")
        .select("notification_email")
        .eq("id", clientId)
        .maybeSingle();
      notificationEmail =
        (cl as { notification_email: string | null } | null)?.notification_email?.trim().toLowerCase() || null;
    }
    entry = { clientId, notificationEmail };
    clientByCampaign.set(campaignId, entry);
    return entry;
  };

  for (const mailbox of mailboxes) {
    if (processed >= MAX_MESSAGES_PER_TICK || fetched >= MAX_FETCH_PER_TICK || Date.now() > tickDeadline) break;

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

      // Search inbox AND spam: bounce notices (mailer-daemon DSNs) are
      // sometimes filtered to spam, and an uncounted bounce is exactly the gap
      // we're closing. Unmatched spam-foldered messages are dropped below;
      // a spam-foldered message that answers OUR thread is still a reply.
      // includeSpamTrash is passed explicitly rather than relying on `in:spam`
      // alone (Gmail's docs do not promise that; SEND-07). TRASH stays
      // excluded by the label filter in the query.
      const query = `(in:inbox OR in:spam) after:${afterSec}`;
      let truncated = false;
      const listed: { id: string; threadId: string }[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const res = await gmail.listMessagesPage(mailbox.email_address, query, LIST_PAGE_SIZE, pageToken, true);
        listed.push(...res.messages);
        if (!res.nextPageToken) {
          pageToken = undefined;
          break;
        }
        pageToken = res.nextPageToken;
      }
      if (pageToken) truncated = true; // more pages than we are willing to walk this tick

      for (const entry of listed) {
        if (processed >= MAX_MESSAGES_PER_TICK || fetched >= MAX_FETCH_PER_TICK || Date.now() > tickDeadline) {
          truncated = true;
          break;
        }

        // Per-message isolation: one malformed or vanished message must not
        // pin the whole mailbox at this watermark forever (CRON-03).
        try {
          fetched++;
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
            // would wrongly kill a reachable lead. So we don't suppress, but we
            // DO stamp the send row so inbox-health can surface a rising
            // soft-bounce rate (an early throttling/greylisting signal). A
            // persistent failure still arrives later as a hard DSN.
            if (bounceSeverity(parsed) === "soft") {
              if (sendRow && sendRow.status !== "bounced") {
                await admin
                  .from("native_sends")
                  .update({ soft_bounced_at: new Date().toISOString() })
                  .eq("id", sendRow.id);
              }
              processed++;
              summary.softBounces++;
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
                // Guarded on active: a replied/completed enrollment keeps its
                // terminal state (a bounce after a reply is a metric, not a
                // suppression change; SEND-44).
                await admin
                  .from("campaign_enrollments")
                  .update({ status: "failed", last_error: "Hard bounce" })
                  .eq("id", sendRow.enrollment_id)
                  .eq("status", "active");
              }
            } else if (recipient) {
              // No thread match, but the DSN names the failed recipient. This is
              // the common case where the far end accepts then rejects: the
              // bounce arrives as a fresh message on its own thread, so the
              // thread-id lookup missed. Mark the MOST RECENT send to that
              // address from this mailbox as bounced so the bounce rate counts
              // it. The old query excluded already-bounced rows, so the same
              // DSN re-read every tick for five minutes walked backwards and
              // marked one more historical send per pass, inflating the
              // bounce count until the circuit breaker tired the domain on a
              // single bounce (SEND-02). Now: latest send only; if it is
              // already bounced this DSN has been handled.
              const { data: fallbackSend } = await admin
                .from("native_sends")
                .select("id, enrollment_id, status")
                .eq("mailbox_id", mailbox.id)
                .ilike("to_email", escapeLikePattern(recipient))
                .order("sent_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              const fb = fallbackSend as { id: string; enrollment_id: string | null; status: string } | null;
              if (fb && fb.status !== "bounced") {
                await admin
                  .from("native_sends")
                  .update({ status: "bounced", bounce_reason: reason, bounced_at: new Date().toISOString() })
                  .eq("id", fb.id);
                if (fb.enrollment_id) {
                  await admin
                    .from("campaign_enrollments")
                    .update({ status: "failed", last_error: "Hard bounce" })
                    .eq("id", fb.enrollment_id)
                    .eq("status", "active");
                }
                // Track this domain for the post-loop bounce circuit breaker
                // only when this DSN actually marked something (not on a re-read).
                if (mailbox.domain_id) bouncedDomains.add(mailbox.domain_id);
              } else if (!fb) {
                if (mailbox.domain_id) bouncedDomains.add(mailbox.domain_id);
              }
              await admin
                .from("contacts")
                .update({ status: "bounced" })
                .eq("organization_id", mailbox.organization_id)
                .ilike("email", escapeLikePattern(recipient));
              processed++;
              summary.bounces++;
              continue;
            }
            // Thread-matched hard bounce: feed the breaker.
            if (mailbox.domain_id) bouncedDomains.add(mailbox.domain_id);
            processed++;
            summary.bounces++;
            continue;
          }

          // ---- Reply branch ----
          if (!sendRow) {
            // Not a reply to any of our campaign sends (spam-foldered or not): ignore.
            summary.dropped++;
            continue;
          }
          const inSpam = (msg.labelIds ?? []).includes("SPAM");

          // Resolve the campaign's client (cached). A message from the client's
          // own notification inbox on our thread is the client, not the lead.
          const client = await resolveClient(sendRow.campaign_id);
          if (fromEmail && client.notificationEmail && fromEmail === client.notificationEmail) {
            summary.dropped++;
            continue;
          }

          // Stop-on-reply, but never on an auto-reply (OOO), which would
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
            client_id: client.clientId,
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
            // An attachment-only / image-only reply has no text part; the
            // Gmail snippet keeps it classifiable instead of parking it
            // unclassified until expiry (SEND-17).
            body_text: parsed.bodyText || msg.snippet || "",
            body_html: parsed.bodyHtml,
            received_at: parsed.internalDateMs ? new Date(parsed.internalDateMs).toISOString() : new Date().toISOString(),
            raw_payload: {
              gmail_message_id: entry.id,
              thread_id: msg.threadId,
              snippet: msg.snippet ?? null,
              from: parsed.from,
              subject: parsed.subject,
              in_spam: inSpam,
            } as Record<string, unknown>,
            status: "new" as const,
          };

          // INSERT-ONLY for an existing row. The old upsert re-applied the whole
          // payload (status "new" included) on every re-read of the 5-minute
          // overlap, so a reply the VA had already handled reverted to "new"
          // and the portal's send claim could pass a second time (SEND-04).
          const { data: inserted, error: insertError } = await admin
            .from("lead_replies")
            .upsert(row, { onConflict: "organization_id,gmail_message_id", ignoreDuplicates: true })
            .select("id")
            .maybeSingle();
          if (insertError) {
            console.error("[cron/native-replies] lead_replies insert failed:", insertError);
            summary.errors++;
            continue;
          }
          let replyId = (inserted as { id: string } | null)?.id ?? null;
          if (!replyId) {
            // Already ingested on an earlier pass; find it so a classification
            // that failed then can still be retried (the pipeline early-returns
            // once final_class is set).
            summary.duplicates++;
            const { data: existing } = await admin
              .from("lead_replies")
              .select("id")
              .eq("organization_id", mailbox.organization_id)
              .eq("gmail_message_id", entry.id)
              .maybeSingle();
            replyId = (existing as { id: string } | null)?.id ?? null;
            if (!replyId) continue;
          }

          // Classify + notify inline (we're in a cron, not a webhook, no
          // after() to defer to; the pipeline is idempotent on final_class).
          try {
            await runReplyPipeline(replyId, admin);
          } catch (err) {
            console.error("[cron/native-replies] runReplyPipeline threw:", err);
          }
          processed++;
          summary.replies++;
        } catch (err) {
          summary.errors++;
          console.error(
            `[cron/native-replies] message ${entry.id} in ${mailbox.email_address} failed; skipping it:`,
            err,
          );
        }
      }

      if (truncated) {
        // Leave last_polled_at alone: the next tick re-reads this window.
        summary.truncated++;
        console.warn(
          `[cron/native-replies] ${mailbox.email_address}: listing truncated (${listed.length} listed); watermark held`,
        );
      } else {
        // Advance the watermark only after the mailbox is fully processed.
        await admin
          .from("native_mailboxes")
          .update({ last_polled_at: new Date(tickStart).toISOString() })
          .eq("id", mailbox.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cron/native-replies] mailbox ${mailbox.email_address} failed:`, err);
      // Leave last_polled_at unchanged so the next tick retries this window,
      // and record the failure where an operator can see it (SEND-10).
      await admin
        .from("native_mailboxes")
        .update({ last_error: `Reply poll failed: ${msg}`.slice(0, 500), last_error_at: new Date().toISOString() })
        .eq("id", mailbox.id);
    }
  }

  // Fast bounce circuit breaker: evaluate every domain that took a hard bounce
  // this tick (rare, so at most a few one-off queries per affected domain).
  const breaker = await evaluateCircuitBreakers(admin, [...bouncedDomains], Date.now());

  return NextResponse.json({ status: "ok", processed, fetched, ...summary, breaker });
}

// ── Bounce circuit breaker ──────────────────────────────────────────────────
// A burst of hard bounces means a poisoned list segment is actively torching a
// domain. This reacts within a minute (poll runs every minute): well ahead of
// the hourly health rollup: by tiring the domain: closing it to NEW leads while
// its in-flight follow-ups drain. Gated by organizations.domain_lifecycle_enabled
// (migration 00082): OFF → observe (log only, no write), matching the lifecycle
// cron. Only warming/active domains can be tripped; the trip is a guarded CAS
// update so a concurrent lifecycle-cron transition can't be clobbered.
async function evaluateCircuitBreakers(
  admin: ReturnType<typeof createAdminClient>,
  domainIds: string[],
  now: number,
): Promise<{ evaluated: number; tripped: number; observed: number }> {
  const result = { evaluated: 0, tripped: 0, observed: 0 };
  if (domainIds.length === 0) return result;

  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date(now).toISOString();

  // Only warming/active domains are trip candidates (tired/resting/etc. already
  // closed intake).
  const { data: domRows, error: domErr } = await admin
    .from("sending_domains")
    .select("id, organization_id, domain, lifecycle_status, drain_until")
    .in("id", domainIds)
    .in("lifecycle_status", ["warming", "active"]);
  if (domErr) {
    console.error("[cron/native-replies] breaker domain read failed:", domErr.message);
    return result;
  }
  const domains = (domRows ?? []) as {
    id: string;
    organization_id: string;
    domain: string;
    lifecycle_status: string;
    drain_until: string | null;
  }[];
  if (domains.length === 0) return result;

  // Per-org lifecycle gate.
  const orgIds = [...new Set(domains.map((d) => d.organization_id))];
  const { data: orgRows } = await admin
    .from("organizations")
    .select("id, domain_lifecycle_enabled")
    .in("id", orgIds);
  const enabledByOrg = new Map<string, boolean>(
    ((orgRows ?? []) as { id: string; domain_lifecycle_enabled: boolean | null }[]).map((o) => [
      o.id,
      o.domain_lifecycle_enabled ?? false,
    ]),
  );

  // All mailbox ids per candidate domain (bounces/sends are counted across the
  // whole domain, not just the mailboxes polled this tick).
  const { data: mbRows } = await admin
    .from("native_mailboxes")
    .select("id, domain_id")
    .in("domain_id", domains.map((d) => d.id));
  const mbByDomain = new Map<string, string[]>();
  for (const mb of (mbRows ?? []) as { id: string; domain_id: string | null }[]) {
    if (!mb.domain_id) continue;
    const arr = mbByDomain.get(mb.domain_id) ?? [];
    arr.push(mb.id);
    mbByDomain.set(mb.domain_id, arr);
  }

  for (const d of domains) {
    const mbIds = mbByDomain.get(d.id) ?? [];
    if (mbIds.length === 0) continue;
    result.evaluated += 1;

    // Trailing-24h hard bounces (count-only) + the most-recent-sends sample.
    const { count: hb24 } = await admin
      .from("native_sends")
      .select("id", { count: "exact", head: true })
      .in("mailbox_id", mbIds)
      .eq("status", "bounced")
      .gte("bounced_at", since24h);
    const { data: recent } = await admin
      .from("native_sends")
      .select("status")
      .in("mailbox_id", mbIds)
      .order("sent_at", { ascending: false })
      .limit(CB_RATE_SAMPLE);
    const sample = (recent ?? []) as { status: string }[];
    const recentHardBounces = sample.filter((r) => r.status === "bounced").length;

    if (
      !shouldTripCircuitBreaker({
        hardBounces24h: hb24 ?? 0,
        recentSends: sample.length,
        recentHardBounces,
      })
    ) {
      continue;
    }

    if (!(enabledByOrg.get(d.organization_id) ?? false)) {
      // Observe-only: the lifecycle gate is off, so report but don't tire.
      result.observed += 1;
      console.warn(
        `[cron/native-replies] circuit breaker WOULD tire ${d.domain} ` +
          `(${hb24 ?? 0} hard bounces/24h): domain_lifecycle_enabled is off.`,
      );
      continue;
    }

    // Trip: tire the domain. Guarded CAS on lifecycle_status so a concurrent
    // lifecycle-cron transition isn't clobbered. Set the drain timer if absent.
    const update: Record<string, unknown> = {
      lifecycle_status: "tired",
      lifecycle_changed_at: nowIso,
    };
    if (!d.drain_until) update.drain_until = enterTimers("tired", now).drain_until;
    const { error: tripErr } = await admin
      .from("sending_domains")
      .update(update)
      .eq("id", d.id)
      .in("lifecycle_status", ["warming", "active"]);
    if (tripErr) {
      console.error(`[cron/native-replies] breaker trip of ${d.domain} failed:`, tripErr.message);
      continue;
    }
    await enqueueOwnerAlert({
      admin,
      kind: "domain_lifecycle",
      subject: `Domain ${d.domain} tired by the bounce circuit breaker`,
      summary:
        `${d.domain} took ${hb24 ?? 0} hard bounce${(hb24 ?? 0) === 1 ? "" : "s"} in the last 24 hours, ` +
        `so it was closed to new leads immediately to stop the damage. In-flight follow-ups drain, then it rests. ` +
        `Check the recipient list that caused it before reactivating.`,
      context: { domain: d.domain, hard_bounces_24h: hb24 ?? 0, trigger: "circuit_breaker" },
    });
    result.tripped += 1;
  }

  return result;
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
