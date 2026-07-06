// GET /api/cron/run-native-sequences
//
// Native email sequence engine tick. Structurally mirrors
// /api/cron/run-linkedin-sequences but sends via the Gmail API (service
// account + domain-wide delegation) instead of Unipile, and adds the
// deliverability machinery that email needs: per-mailbox daily caps with a
// weekly ramp, a Mon–Fri business-hours send window, rotation across a
// campaign's mailbox pool, and threaded follow-ups.
//
// Every run:
//   1. Bail immediately if we're outside the send window (cheap no-op tick).
//   2. Pull active enrollments on native_email campaigns whose current
//      step's wait_days has elapsed (channel filtered in SQL — see below).
//   3. For each, pick a mailbox (sticky per enrollment for thread
//      continuity; else the least-loaded mailbox in the campaign's pool),
//      render + send the step, log it to native_sends, advance the
//      enrollment.
//
// Pacing is at-most-once with no locking, same accepted stance as the
// existing dispatch crons: a send either happens and is logged, or it
// doesn't and the next tick retries. Transient/rate-limit failures leave
// the enrollment active for retry; permanent failures mark it failed.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { GmailClient, GmailConfigError, GmailAuthError, GmailPermanentError, GmailRateLimitError, GmailTransientError } from "@/lib/gmail/client";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { buildRawEmail, generateMessageId } from "@/lib/gmail/mime";
import { effectiveDailyCap, isInSendWindow, resolveSendWindow, startOfLocalDay } from "@/lib/gmail/ramp";
import { renderSpintax } from "@/lib/spintax";
import { buildTokenMap, applyTokens } from "@/lib/native/tokens";
import type {
  CampaignEnrollment,
  CampaignStep,
  Contact,
  NativeMailbox,
} from "@/types/app";

export const maxDuration = 60;
// See run-linkedin-sequences for the edge-cache incident this guards against.
export const dynamic = "force-dynamic";

// Global per-tick send budget. Each send is ~2 Gmail calls (send + Message-ID
// read-back) ≈ 1-2s, so 20 sends stays well under the 60s function budget.
// With 15-min ticks over the 9-hour window (~36 ticks) this is far more
// throughput than the per-mailbox daily caps will ever allow.
const SENDS_PER_TICK = 20;
// Spread each mailbox's daily allotment across ticks instead of firing its
// whole remaining cap in one burst.
const PER_MAILBOX_PER_TICK = 5;

type EnrollmentRow = CampaignEnrollment;
type CampaignRow = {
  id: string;
  organization_id: string;
  client_id: string | null;
  status: string;
  source_channel: string;
  name: string;
  send_timezone: string | null;
  send_start_hour: number | null;
  send_end_hour: number | null;
  send_weekdays_only: boolean | null;
};

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  // Send windows are now per-campaign (migration 00058), so the global
  // "outside window" bail moved into the loop below — each enrollment is
  // gated on its OWN campaign's window (timezone + hours). The cron still
  // fires all day; ticks where every due campaign is out of window fetch a
  // little and then send nothing.
  const tickNow = new Date();
  const admin = createAdminClient();

  // Active enrollments on native_email campaigns only — filtered in SQL via
  // an inner join so this worker never overfetches LinkedIn/Salesforge rows
  // (which would starve throughput once channels run concurrently).
  const { data: enrollmentsData, error: enrError } = await admin
    .from("campaign_enrollments")
    .select("*, campaigns!inner(source_channel)")
    .eq("status", "active")
    .eq("campaigns.source_channel", "native_email")
    .order("last_action_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(SENDS_PER_TICK * 3);

  if (enrError) {
    console.error("[cron/native-sequences] enrollment fetch failed:", enrError);
    return NextResponse.json({ error: enrError.message }, { status: 500 });
  }
  const enrollments = (enrollmentsData ?? []) as unknown as EnrollmentRow[];
  if (enrollments.length === 0) {
    return NextResponse.json({ status: "idle" });
  }

  // ---- Bulk prefetch everything the loop needs ----
  const campaignIds = [...new Set(enrollments.map((e) => e.campaign_id))];
  const contactIds = [...new Set(enrollments.map((e) => e.contact_id))];

  const { data: campaignsData } = await admin
    .from("campaigns")
    .select("id, organization_id, client_id, status, source_channel, name, send_timezone, send_start_hour, send_end_hour, send_weekdays_only")
    .in("id", campaignIds);
  const campaignMap = new Map<string, CampaignRow>();
  for (const c of (campaignsData ?? []) as CampaignRow[]) campaignMap.set(c.id, c);

  // Steps, grouped by campaign then step_index.
  const { data: stepsData } = await admin
    .from("campaign_steps")
    .select("*")
    .in("campaign_id", campaignIds)
    .order("step_index", { ascending: true });
  const stepsByCampaign = new Map<string, Map<number, CampaignStep>>();
  for (const s of (stepsData ?? []) as CampaignStep[]) {
    let m = stepsByCampaign.get(s.campaign_id);
    if (!m) {
      m = new Map();
      stepsByCampaign.set(s.campaign_id, m);
    }
    m.set(s.step_index, s);
  }

  const { data: contactsData } = await admin
    .from("contacts")
    .select("*")
    .in("id", contactIds);
  const contactMap = new Map<string, Contact>();
  for (const c of (contactsData ?? []) as Contact[]) contactMap.set(c.id, c);

  // Per-client DNC prefetch. An opt-out is scoped to the client the person
  // replied to, so a send is blocked only when the contact's email is on THIS
  // campaign's client's DNC list (or an org-wide entry with client_id NULL).
  // Bounded by the tick's contact set → a small IN-list query.
  const orgIds = [...new Set([...campaignMap.values()].map((c) => c.organization_id))];
  const dncEmails = [
    ...new Set(
      [...contactMap.values()]
        .map((c) => c.email?.trim().toLowerCase())
        .filter((e): e is string => !!e),
    ),
  ];
  // email -> set of blocked client_ids ("*" = org-wide, i.e. client_id NULL).
  const dncByEmail = new Map<string, Set<string>>();
  if (dncEmails.length > 0 && orgIds.length > 0) {
    const { data: dncRows } = await admin
      .from("dnc_entries")
      .select("client_id, email")
      .in("organization_id", orgIds)
      .in("email", dncEmails);
    for (const row of (dncRows ?? []) as { client_id: string | null; email: string }[]) {
      const key = row.email.trim().toLowerCase();
      let s = dncByEmail.get(key);
      if (!s) {
        s = new Set();
        dncByEmail.set(key, s);
      }
      s.add(row.client_id ?? "*");
    }
  }

  // Campaign → mailbox pool.
  const { data: poolData } = await admin
    .from("campaign_mailboxes")
    .select("campaign_id, mailbox_id")
    .in("campaign_id", campaignIds);
  const poolByCampaign = new Map<string, string[]>();
  for (const row of (poolData ?? []) as { campaign_id: string; mailbox_id: string }[]) {
    const arr = poolByCampaign.get(row.campaign_id) ?? [];
    arr.push(row.mailbox_id);
    poolByCampaign.set(row.campaign_id, arr);
  }

  // All mailboxes referenced by a pool or a sticky enrollment binding.
  const referencedMailboxIds = new Set<string>();
  for (const ids of poolByCampaign.values()) ids.forEach((id) => referencedMailboxIds.add(id));
  for (const e of enrollments) if (e.native_mailbox_id) referencedMailboxIds.add(e.native_mailbox_id);

  const mailboxMap = new Map<string, NativeMailbox>();
  if (referencedMailboxIds.size > 0) {
    const { data: mbData } = await admin
      .from("native_mailboxes")
      .select("*")
      .in("id", [...referencedMailboxIds]);
    for (const mb of (mbData ?? []) as NativeMailbox[]) mailboxMap.set(mb.id, mb);
  }

  // Sends already made today, per mailbox (ET-day boundary, matching the cap).
  const dayStart = new Date(startOfLocalDay()).toISOString();
  const sentToday: Record<string, number> = {};
  if (referencedMailboxIds.size > 0) {
    const { data: sendRows } = await admin
      .from("native_sends")
      .select("mailbox_id")
      .in("mailbox_id", [...referencedMailboxIds])
      .gte("sent_at", dayStart);
    for (const s of (sendRows ?? []) as { mailbox_id: string }[]) {
      sentToday[s.mailbox_id] = (sentToday[s.mailbox_id] ?? 0) + 1;
    }
  }

  // Cumulative all-time sends per mailbox — drives the volume-based warmup ramp
  // (effectiveDailyCap). Count-only (head:true) so no rows transfer; a paused
  // inbox that hasn't sent stays at the low starting cap until it warms up.
  const totalSent: Record<string, number> = {};
  await Promise.all(
    [...referencedMailboxIds].map(async (id) => {
      const { count } = await admin
        .from("native_sends")
        .select("id", { count: "exact", head: true })
        .eq("mailbox_id", id);
      totalSent[id] = count ?? 0;
    }),
  );

  // Per-tick per-mailbox counter (in addition to the daily count above).
  const inTick: Record<string, number> = {};
  const gmailByOrg = new Map<string, GmailClient | null>();
  // Cache each campaign's "is it in its send window right now" so we compute
  // the Intl/timezone math once per campaign per tick, not once per enrollment.
  const inWindowByCampaign = new Map<string, boolean>();

  const remaining = (mb: NativeMailbox) =>
    effectiveDailyCap(mb, totalSent[mb.id] ?? 0) - (sentToday[mb.id] ?? 0) - (inTick[mb.id] ?? 0);
  const eligible = (mb: NativeMailbox) =>
    mb.status === "active" && remaining(mb) > 0 && (inTick[mb.id] ?? 0) < PER_MAILBOX_PER_TICK;

  let sent = 0;
  const results: Array<{ enrollment_id: string; result: string }> = [];

  for (const enrollment of enrollments) {
    if (sent >= SENDS_PER_TICK) break;

    const campaign = campaignMap.get(enrollment.campaign_id);
    if (!campaign || campaign.status !== "active" || campaign.source_channel !== "native_email") {
      continue;
    }

    // Gate on THIS campaign's send window (its own timezone + hours; falls
    // back to the global ET default when unset). Out-of-window campaigns are
    // skipped this tick and retried on a later one inside their window.
    if (!inWindowByCampaign.has(campaign.id)) {
      inWindowByCampaign.set(campaign.id, isInSendWindow(tickNow, resolveSendWindow(campaign)));
    }
    if (!inWindowByCampaign.get(campaign.id)) continue;

    const steps = stepsByCampaign.get(campaign.id);
    const step = steps?.get(enrollment.current_step_index);
    if (!step) {
      await admin
        .from("campaign_enrollments")
        .update({ status: "completed" })
        .eq("id", enrollment.id);
      results.push({ enrollment_id: enrollment.id, result: "completed" });
      continue;
    }

    // wait_days gate — step 0 uses started_at, later steps last_action_at.
    const referenceTime = enrollment.last_action_at ?? enrollment.started_at;
    if (step.wait_days > 0 && referenceTime) {
      const dueAt = new Date(referenceTime).getTime() + step.wait_days * 86_400_000;
      if (Date.now() < dueAt) continue;
    }

    const contact = contactMap.get(enrollment.contact_id);
    if (!contact) {
      await markEnrollmentFailed(admin, enrollment.id, "Contact no longer exists.");
      results.push({ enrollment_id: enrollment.id, result: "failed_no_contact" });
      continue;
    }
    if (!contact.email) {
      await markEnrollmentFailed(admin, enrollment.id, "Contact has no email address.");
      results.push({ enrollment_id: enrollment.id, result: "failed_no_email" });
      continue;
    }
    // Suppression: never send to a contact who bounced, unsubscribed, or
    // already replied. 'replied' halts the sequence; the others fail it.
    if (contact.status === "replied") {
      await admin.from("campaign_enrollments").update({ status: "replied" }).eq("id", enrollment.id);
      results.push({ enrollment_id: enrollment.id, result: "already_replied" });
      continue;
    }
    if (contact.status === "bounced" || contact.status === "unsubscribed") {
      await markEnrollmentFailed(admin, enrollment.id, `Contact is ${contact.status}.`);
      results.push({ enrollment_id: enrollment.id, result: `suppressed_${contact.status}` });
      continue;
    }
    // Per-client DNC: skip if this contact opted out of THIS campaign's client
    // (or an org-wide entry). Scoped so another client sharing the contact is
    // unaffected — that's the whole point of the per-client list.
    const emailKey = contact.email.trim().toLowerCase();
    const dncClients = dncByEmail.get(emailKey);
    if (dncClients && (dncClients.has(campaign.client_id ?? "*") || dncClients.has("*"))) {
      await markEnrollmentFailed(admin, enrollment.id, "Contact is on the client's DNC list.");
      results.push({ enrollment_id: enrollment.id, result: "suppressed_dnc" });
      continue;
    }

    // ---- Pick the mailbox ----
    let mailbox: NativeMailbox | undefined;
    if (enrollment.native_mailbox_id) {
      // Sticky: this enrollment already threads through one mailbox. If it's
      // ineligible this tick (paused, error, or at cap), wait — never
      // reroute mid-thread (breaks threading + SPF alignment).
      mailbox = mailboxMap.get(enrollment.native_mailbox_id);
      if (!mailbox || !eligible(mailbox)) continue;
    } else {
      // Step 0: choose the least-loaded eligible mailbox in the pool.
      const pool = (poolByCampaign.get(campaign.id) ?? [])
        .map((id) => mailboxMap.get(id))
        .filter((mb): mb is NativeMailbox => !!mb && eligible(mb));
      if (pool.length === 0) continue; // nothing available this tick
      pool.sort((a, b) => remaining(b) - remaining(a) || (inTick[a.id] ?? 0) - (inTick[b.id] ?? 0));
      mailbox = pool[0];
    }

    // ---- Render subject + body ----
    const bodyText = renderTemplate(
      step.body_template ?? "",
      contact,
      mailbox,
      `${contact.id}:${enrollment.current_step_index}:body`,
    );
    if (!bodyText) {
      await markEnrollmentFailed(admin, enrollment.id, "Rendered email body is empty.");
      results.push({ enrollment_id: enrollment.id, result: "failed_empty_body" });
      continue;
    }
    let subject: string;
    if (enrollment.current_step_index === 0) {
      subject = renderTemplate(
        step.subject_template ?? "",
        contact,
        mailbox,
        `${contact.id}:0:subject`,
      );
      if (!subject) {
        await markEnrollmentFailed(admin, enrollment.id, "Step 0 has no subject.");
        results.push({ enrollment_id: enrollment.id, result: "failed_no_subject" });
        continue;
      }
    } else if ((step.subject_template ?? "").trim()) {
      // This follow-up carries its own subject line — send under it (still
      // threaded via References + threadId). Lets a sequence vary the subject
      // per step instead of forcing every follow-up to "Re: <first subject>".
      subject = renderTemplate(
        step.subject_template ?? "",
        contact,
        mailbox,
        `${contact.id}:${enrollment.current_step_index}:subject`,
      );
    } else {
      const step0 = steps?.get(0);
      // Re: fallback — re-render STEP 0's subject with STEP 0's seed key (index
      // 0, NOT the sending step index) so the threaded subject is byte-identical
      // to the original send ("Re: Quick question", never "Re: Fast question").
      const baseSubject =
        renderTemplate(
          step0?.subject_template ?? "",
          contact,
          mailbox,
          `${contact.id}:0:subject`,
        ) || "(no subject)";
      subject = baseSubject.toLowerCase().startsWith("re:") ? baseSubject : `Re: ${baseSubject}`;
    }

    // ---- Gmail client for the org (cached per tick) ----
    if (!gmailByOrg.has(campaign.organization_id)) {
      try {
        gmailByOrg.set(campaign.organization_id, await loadGmailClientForOrg(admin, campaign.organization_id));
      } catch (err) {
        gmailByOrg.set(campaign.organization_id, null);
        console.error("[cron/native-sequences] no Gmail creds for org", campaign.organization_id, err);
      }
    }
    const gmail = gmailByOrg.get(campaign.organization_id);
    if (!gmail) continue; // org not configured; leave enrollment active

    const messageId = generateMessageId(mailbox.email_address);
    const raw = buildRawEmail({
      fromEmail: mailbox.email_address,
      fromName: mailbox.display_name,
      to: contact.email,
      subject,
      bodyText,
      messageId,
      inReplyTo: enrollment.current_step_index === 0 ? null : enrollment.last_rfc_message_id,
      references: enrollment.current_step_index === 0 ? null : enrollment.last_rfc_message_id,
    });

    // ---- Send ----
    let sendResult: { id: string; threadId: string };
    try {
      sendResult = await gmail.sendMessage(
        mailbox.email_address,
        raw,
        enrollment.gmail_thread_id ?? undefined,
      );
    } catch (err) {
      if (err instanceof GmailAuthError) {
        // Delegation broke for this mailbox — bench it and skip its
        // enrollments for the rest of the tick. Leave the enrollment active.
        await admin
          .from("native_mailboxes")
          .update({ status: "error", last_error: err.message, last_error_at: new Date().toISOString() })
          .eq("id", mailbox.id);
        mailbox.status = "error";
        results.push({ enrollment_id: enrollment.id, result: "mailbox_auth_error" });
        continue;
      }
      if (err instanceof GmailRateLimitError || err instanceof GmailTransientError) {
        // Retry next tick — do not advance.
        results.push({ enrollment_id: enrollment.id, result: "retry_later" });
        continue;
      }
      // GmailPermanentError (bad recipient etc.) or anything unexpected — fail
      // the enrollment so it stops looping.
      const msg =
        err instanceof GmailPermanentError || err instanceof GmailConfigError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      await markEnrollmentFailed(admin, enrollment.id, `Send failed: ${msg}`);
      results.push({ enrollment_id: enrollment.id, result: "failed_send" });
      continue;
    }

    // ---- Read back the authoritative Message-ID for threading ----
    let rfcMessageId = messageId;
    try {
      const meta = await gmail.getMessage(mailbox.email_address, sendResult.id, "metadata", ["Message-ID"]);
      const hdr = meta.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id");
      if (hdr?.value) rfcMessageId = hdr.value;
    } catch {
      // Non-fatal: fall back to the Message-ID we generated (Gmail usually
      // preserves it). Threading still works via threadId.
    }

    // ---- Log the send + advance the enrollment ----
    await admin.from("native_sends").insert({
      organization_id: campaign.organization_id,
      campaign_id: campaign.id,
      contact_id: contact.id,
      enrollment_id: enrollment.id,
      mailbox_id: mailbox.id,
      step_index: enrollment.current_step_index,
      to_email: contact.email,
      rfc_message_id: rfcMessageId,
      gmail_message_id: sendResult.id,
      gmail_thread_id: sendResult.threadId,
      status: "sent",
    });

    const nextIndex = enrollment.current_step_index + 1;
    const hasNext = steps?.has(nextIndex) ?? false;
    await admin
      .from("campaign_enrollments")
      .update({
        current_step_index: nextIndex,
        last_action_at: new Date().toISOString(),
        native_mailbox_id: mailbox.id,
        gmail_thread_id: sendResult.threadId,
        last_rfc_message_id: rfcMessageId,
        last_error: null,
        status: hasNext ? "active" : "completed",
      })
      .eq("id", enrollment.id);

    // First send flips a queued/new contact to 'active' (it's now sending).
    if (enrollment.current_step_index === 0) {
      await admin
        .from("contacts")
        .update({ status: "active" })
        .eq("id", contact.id)
        .in("status", ["new", "enriched", "queued", "uploaded"]);
    }

    sentToday[mailbox.id] = (sentToday[mailbox.id] ?? 0) + 1;
    inTick[mailbox.id] = (inTick[mailbox.id] ?? 0) + 1;
    sent++;
    results.push({ enrollment_id: enrollment.id, result: hasNext ? "advanced" : "completed" });
  }

  return NextResponse.json({ status: "ok", sent, results });
}

// Render sequence copy against a contact + the sending mailbox. Resolves
// {{token}} placeholders case/format-insensitively, in priority order:
//
//   1. Sender identity from the sending inbox — {{YourName}} / {{sender_name}}
//      resolve to the mailbox's display name (fallback: the address local
//      part). This is what keeps a rotating-inbox signature correct: a send
//      from molly@ signs "Molly Anderson", from jessica@ "Jessica Masterson".
//   2. Standard contact columns (first_name, last_name, company, title,
//      intro_line, email, phone, full_name).
//   3. Anything the operator imported into contacts.custom_fields
//      (e.g. PropertyAddress, SoldDate) — arbitrary per-recipient merge data.
//
// A token that matches nothing is left in place unchanged (same stance as the
// original fixed-tag renderer) so a typo'd placeholder never silently blanks
// a line of copy — it shows up in a preview instead.
function renderTemplate(
  template: string,
  contact: Contact,
  mailbox: NativeMailbox,
  spinKey?: string,
): string {
  // ORDERING IS LOAD-BEARING: resolve spintax BEFORE token substitution.
  // Token values come from operator-imported contact custom_fields (CSV data)
  // that may contain { | } characters; feeding those into the spintax parser
  // would corrupt the render. Spintax-first only ever parses author-written
  // template text, and a {{token}} chosen inside a spin branch still gets
  // filled by the token pass below.
  const source = spinKey ? renderSpintax(template, spinKey) : template;

  const senderName =
    mailbox.display_name?.trim() || mailbox.email_address.split("@")[0];

  // buildTokenMap / applyTokens are the shared source of truth (also used by the
  // builder preview), keeping the send and the preview byte-identical.
  const map = buildTokenMap(contact, senderName);
  return applyTokens(source, map).trim();
}

async function markEnrollmentFailed(
  admin: ReturnType<typeof createAdminClient>,
  enrollmentId: string,
  reason: string,
): Promise<void> {
  await admin
    .from("campaign_enrollments")
    .update({ status: "failed", last_error: reason })
    .eq("id", enrollmentId);
}
