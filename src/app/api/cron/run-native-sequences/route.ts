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
//      render the step, then verify the recipient just-in-time (Million
//      Verifier): fresh cached results send with no API call, invalid/
//      disposable are skipped, and unknown/errors or a verifier outage HOLD
//      (fail-closed). Then send the step, log it to native_sends, advance the
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
import {
  effectiveDailyCap,
  isInSendWindow,
  resolveSendWindow,
  startOfLocalDay,
  resolveDailyNewLeadsCap,
  resolveSendingStrategy,
  minutesUntilWindowClose,
  sendSpacingMinutes,
  type SendWindowConfig,
} from "@/lib/gmail/ramp";
import { renderSpintax } from "@/lib/spintax";
import { buildTokenMap, applyTokens } from "@/lib/native/tokens";
import { loadVerifierStates, finalizeVerifierStates } from "@/lib/millionverifier/org-state";
import { gateContactVerification } from "@/lib/millionverifier/verify-contact";
import { domainOpenForNewLeads } from "@/lib/deliverability/lifecycle";
import type {
  CampaignEnrollment,
  CampaignStep,
  Contact,
  DomainLifecycle,
  NativeMailbox,
} from "@/types/app";

export const maxDuration = 60;
// See run-linkedin-sequences for the edge-cache incident this guards against.
export const dynamic = "force-dynamic";

// Global per-tick send budget. Each send is ~2 Gmail calls (send + Message-ID
// read-back) ≈ 1-2s, so 20 sends stays well under the 60s function budget.
const SENDS_PER_TICK = 20;
// At most one send per inbox per tick. The cron runs every 5 min (= the minimum
// send gap), and each inbox is additionally gated on a dynamic spacing interval
// (sendSpacingMinutes) so its daily allotment is spread across the whole send
// window instead of fired in a burst.
const PER_MAILBOX_PER_TICK = 1;

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
  daily_new_leads_cap: number | null;
  sending_strategy: string | null;
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

  // Active enrollments on native_email campaigns only (filtered in SQL via an
  // inner join so this worker never overfetches other channels' rows).
  //
  // Follow-ups and never-sent leads are fetched in SEPARATE capped queries and
  // combined, rather than one ordered fetch with a single row cap. The old
  // single-fetch ordered already-sent rows (last_action_at NOT NULL) ahead of
  // new step-0 rows, so once a campaign's active in-flight population exceeded
  // the row cap, brand-new leads never entered the batch and first-touches
  // stopped sending altogether. Two capped fetches guarantee BOTH classes are
  // present every tick; the per-campaign strategy sort below (after we know each
  // campaign's sending_strategy) decides which class wins the day's send slots.
  const FETCH_LIMIT = SENDS_PER_TICK * 3;
  const [followupRes, newLeadRes] = await Promise.all([
    admin
      .from("campaign_enrollments")
      .select("*, campaigns!inner(source_channel)")
      .eq("status", "active")
      .eq("campaigns.source_channel", "native_email")
      .not("last_action_at", "is", null)
      .order("last_action_at", { ascending: true })
      .limit(FETCH_LIMIT),
    admin
      .from("campaign_enrollments")
      .select("*, campaigns!inner(source_channel)")
      .eq("status", "active")
      .eq("campaigns.source_channel", "native_email")
      .is("last_action_at", null)
      .order("started_at", { ascending: true })
      .limit(FETCH_LIMIT),
  ]);

  const enrError = followupRes.error ?? newLeadRes.error;
  if (enrError) {
    console.error("[cron/native-sequences] enrollment fetch failed:", enrError);
    return NextResponse.json({ error: enrError.message }, { status: 500 });
  }
  const enrollments = [
    ...((followupRes.data ?? []) as unknown as EnrollmentRow[]),
    ...((newLeadRes.data ?? []) as unknown as EnrollmentRow[]),
  ];
  if (enrollments.length === 0) {
    return NextResponse.json({ status: "idle" });
  }

  // ---- Bulk prefetch everything the loop needs ----
  const campaignIds = [...new Set(enrollments.map((e) => e.campaign_id))];
  const contactIds = [...new Set(enrollments.map((e) => e.contact_id))];

  const { data: campaignsData } = await admin
    .from("campaigns")
    .select("id, organization_id, client_id, status, source_channel, name, send_timezone, send_start_hour, send_end_hour, send_weekdays_only, daily_new_leads_cap, sending_strategy")
    .in("id", campaignIds);
  const campaignMap = new Map<string, CampaignRow>();
  for (const c of (campaignsData ?? []) as CampaignRow[]) campaignMap.set(c.id, c);

  // Per-campaign strategy ordering. Within a campaign, reach_first processes new
  // first-touches (last_action_at NULL) before follow-ups; finish_first (the
  // default) processes follow-ups first. Across campaigns the two classes
  // interleave by due-ness. Array.sort is stable in V8, so within a rank ties
  // keep the DB order (oldest-actioned / oldest-started first). This is the ONLY
  // place strategy changes send order — the loop below is otherwise identical.
  const enrollmentRank = (e: EnrollmentRow): number => {
    const strat = resolveSendingStrategy(campaignMap.get(e.campaign_id) ?? {});
    const isNewLead = e.last_action_at == null;
    if (strat === "reach_first") return isNewLead ? 0 : 1;
    return isNewLead ? 1 : 0;
  };
  enrollments.sort((a, b) => {
    const r = enrollmentRank(a) - enrollmentRank(b);
    if (r !== 0) return r;
    const ta = a.last_action_at ? Date.parse(a.last_action_at) : 0;
    const tb = b.last_action_at ? Date.parse(b.last_action_at) : 0;
    if (ta !== tb) return ta - tb;
    const sa = a.started_at ? Date.parse(a.started_at) : 0;
    const sb = b.started_at ? Date.parse(b.started_at) : 0;
    return sa - sb;
  });

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

  // Per-org Million Verifier state for this tick: the client (null = gate
  // disarmed when no key is configured), the 1h suppression window carried over
  // from a definitive account error, and the per-tick breaker + tallies the
  // gate mutates as it runs. A missing-column error (migration 00069 not yet
  // applied) disarms the gate rather than throwing — sends proceed unverified.
  const verifierByOrg = await loadVerifierStates(admin, orgIds, tickNow);

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

  // Domain lifecycle for drain-mode routing (migration 00081). A domain that is
  // NOT open to new leads (tired = draining, resting, etc.) accepts no fresh
  // step-0 enrollments — but its in-flight sticky follow-ups continue untouched,
  // because the sticky path below never consults this. A mailbox with no
  // domain_id (legacy / pre-backfill) is treated as open. On day one every
  // backfilled domain is 'active', so this filter is a no-op until the lifecycle
  // cron (or the fast bounce breaker) starts tiring domains.
  const domainStatusByMailbox = new Map<string, DomainLifecycle>();
  // Domains WITH an optional daily send cap (migration 00083). Empty for the
  // common case (no caps) → all cap bookkeeping below is skipped.
  const capByDomainId = new Map<string, number>();
  const domainIds = [
    ...new Set(
      [...mailboxMap.values()].map((m) => m.domain_id).filter((id): id is string => !!id),
    ),
  ];
  if (domainIds.length > 0) {
    const { data: domainRows } = await admin
      .from("sending_domains")
      .select("id, lifecycle_status, max_daily_sends")
      .in("id", domainIds);
    const statusById = new Map<string, DomainLifecycle>();
    for (const d of (domainRows ?? []) as {
      id: string;
      lifecycle_status: DomainLifecycle;
      max_daily_sends: number | null;
    }[]) {
      statusById.set(d.id, d.lifecycle_status);
      if (d.max_daily_sends != null) capByDomainId.set(d.id, d.max_daily_sends);
    }
    for (const mb of mailboxMap.values()) {
      const st = mb.domain_id ? statusById.get(mb.domain_id) : undefined;
      if (st) domainStatusByMailbox.set(mb.id, st);
    }
  }
  // A mailbox is eligible for NEW step-0 leads only if its domain is open
  // (warming/active). Unknown/legacy domains default open. Sticky follow-ups
  // bypass this entirely — a draining domain must still finish its threads.
  const domainOpenFor = (mb: NativeMailbox): boolean => {
    const st = domainStatusByMailbox.get(mb.id);
    return st == null || domainOpenForNewLeads(st);
  };

  // Sends already made today, per mailbox (ET-day boundary, matching the cap) —
  // both the count (for the daily cap) and the most-recent send time (for the
  // pacing gate below).
  const dayStart = new Date(startOfLocalDay()).toISOString();
  const sentToday: Record<string, number> = {};
  const lastSentTodayMs: Record<string, number> = {};
  if (referencedMailboxIds.size > 0) {
    const { data: sendRows } = await admin
      .from("native_sends")
      .select("mailbox_id, sent_at")
      .in("mailbox_id", [...referencedMailboxIds])
      .gte("sent_at", dayStart);
    for (const s of (sendRows ?? []) as { mailbox_id: string; sent_at: string | null }[]) {
      sentToday[s.mailbox_id] = (sentToday[s.mailbox_id] ?? 0) + 1;
      if (s.sent_at) {
        const t = Date.parse(s.sent_at);
        if (!(s.mailbox_id in lastSentTodayMs) || t > lastSentTodayMs[s.mailbox_id]) {
          lastSentTodayMs[s.mailbox_id] = t;
        }
      }
    }
  }

  // New leads (step-0 first-touches) already sent today, per campaign — drives
  // the per-campaign daily new-leads cap. Follow-ups are not counted here.
  const newLeadsToday: Record<string, number> = {};
  {
    const { data: newLeadRows } = await admin
      .from("native_sends")
      .select("campaign_id")
      .in("campaign_id", campaignIds)
      .eq("step_index", 0)
      .gte("sent_at", dayStart);
    for (const r of (newLeadRows ?? []) as { campaign_id: string }[]) {
      newLeadsToday[r.campaign_id] = (newLeadsToday[r.campaign_id] ?? 0) + 1;
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
  // Per-tick per-campaign new-lead counter (added to newLeadsToday).
  const newLeadsInTick: Record<string, number> = {};
  const gmailByOrg = new Map<string, GmailClient | null>();
  // Cache each campaign's resolved send window + "in window right now" so the
  // Intl/timezone math runs once per campaign per tick, not per enrollment.
  const windowByCampaign = new Map<string, SendWindowConfig>();
  const inWindowByCampaign = new Map<string, boolean>();
  const windowFor = (c: CampaignRow): SendWindowConfig => {
    let w = windowByCampaign.get(c.id);
    if (!w) {
      w = resolveSendWindow(c);
      windowByCampaign.set(c.id, w);
    }
    return w;
  };

  // Optional per-domain daily send cap (migration 00083). Inert unless some
  // domain has max_daily_sends set — then count the domain's TRUE sends today
  // across ALL its mailboxes (not just this campaign's pool) so the ceiling
  // holds domain-wide. domainInTick tracks this tick's sends per domain.
  const domainSentToday = new Map<string, number>();
  const domainInTick = new Map<string, number>();
  if (capByDomainId.size > 0) {
    const cappedIds = [...capByDomainId.keys()];
    const { data: cappedMbs } = await admin
      .from("native_mailboxes")
      .select("id, domain_id")
      .in("domain_id", cappedIds);
    const domainByMailbox = new Map<string, string>();
    const cappedMailboxIds: string[] = [];
    for (const m of (cappedMbs ?? []) as { id: string; domain_id: string | null }[]) {
      if (!m.domain_id) continue;
      domainByMailbox.set(m.id, m.domain_id);
      cappedMailboxIds.push(m.id);
    }
    if (cappedMailboxIds.length > 0) {
      const { data: capSends } = await admin
        .from("native_sends")
        .select("mailbox_id")
        .in("mailbox_id", cappedMailboxIds)
        .gte("sent_at", dayStart);
      for (const s of (capSends ?? []) as { mailbox_id: string }[]) {
        const dId = domainByMailbox.get(s.mailbox_id);
        if (dId) domainSentToday.set(dId, (domainSentToday.get(dId) ?? 0) + 1);
      }
    }
  }
  // A mailbox whose domain has hit its daily send ceiling is ineligible — for
  // ALL sends (sticky follow-ups included), since the cap is a domain-wide daily
  // volume limit. No cap set (the common case) → always true.
  const domainUnderCap = (mb: NativeMailbox): boolean => {
    if (!mb.domain_id) return true;
    const cap = capByDomainId.get(mb.domain_id);
    if (cap == null) return true;
    const used = (domainSentToday.get(mb.domain_id) ?? 0) + (domainInTick.get(mb.domain_id) ?? 0);
    return used < cap;
  };

  // ramp_baseline_sent (migration 00081) offsets the all-time count before the
  // ramp reads it, so a re-activated RESTED mailbox re-warms from stage 1 instead
  // of resuming at full cap. 0 for every existing mailbox → identical behavior.
  const rampSent = (mb: NativeMailbox) =>
    Math.max(0, (totalSent[mb.id] ?? 0) - (mb.ramp_baseline_sent ?? 0));
  const remaining = (mb: NativeMailbox) =>
    effectiveDailyCap(mb, rampSent(mb)) - (sentToday[mb.id] ?? 0) - (inTick[mb.id] ?? 0);
  // Spacing gate: an inbox that already sent today must wait out its dynamic
  // interval (day's remaining allotment spread over the window's remaining time,
  // floored at 5 min) before sending again. Its first send of the day is ungated.
  const paced = (mb: NativeMailbox, campaign: CampaignRow): boolean => {
    const last = lastSentTodayMs[mb.id];
    if (last == null) return true;
    const windowLeft = minutesUntilWindowClose(tickNow, windowFor(campaign));
    const gapMin = sendSpacingMinutes(windowLeft, remaining(mb));
    return (tickNow.getTime() - last) / 60000 >= gapMin;
  };
  const eligible = (mb: NativeMailbox, campaign: CampaignRow) =>
    mb.status === "active" &&
    remaining(mb) > 0 &&
    (inTick[mb.id] ?? 0) < PER_MAILBOX_PER_TICK &&
    paced(mb, campaign) &&
    domainUnderCap(mb);

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
      inWindowByCampaign.set(campaign.id, isInSendWindow(tickNow, windowFor(campaign)));
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

    // Per-campaign new-leads/day gate for step-0 first-touches. A cap of 0
    // pauses new leads in BOTH strategies (an explicit off switch). Under
    // finish_first the numeric cap throttles the daily first-touch rate; under
    // reach_first the cap is NOT a rate limit — first-touches use full warmed
    // inbox capacity, still bounded by the per-mailbox ceiling in eligible().
    // Follow-ups (step 1+) are never gated here. Leaves the enrollment active to
    // retry once the day's count resets.
    if (enrollment.current_step_index === 0) {
      const newLeadCap = resolveDailyNewLeadsCap(campaign);
      if (newLeadCap <= 0) {
        results.push({ enrollment_id: enrollment.id, result: "new_leads_paused" });
        continue;
      }
      if (resolveSendingStrategy(campaign) === "finish_first") {
        const usedNewLeads = (newLeadsToday[campaign.id] ?? 0) + (newLeadsInTick[campaign.id] ?? 0);
        if (usedNewLeads >= newLeadCap) {
          results.push({ enrollment_id: enrollment.id, result: "new_leads_cap_reached" });
          continue;
        }
      }
    }

    // ---- Pick the mailbox ----
    let mailbox: NativeMailbox | undefined;
    if (enrollment.native_mailbox_id) {
      // Sticky: this enrollment already threads through one mailbox. If it's
      // ineligible this tick (paused, error, at cap, or not yet due per the
      // spacing gate), wait — never reroute mid-thread (breaks threading + SPF).
      mailbox = mailboxMap.get(enrollment.native_mailbox_id);
      if (!mailbox || !eligible(mailbox, campaign)) continue;
    } else {
      // Step 0: choose the least-loaded eligible mailbox in the pool whose
      // domain is still open to new leads (drain mode excludes tired/resting
      // domains from NEW first-touches; their in-flight threads continue above).
      const pool = (poolByCampaign.get(campaign.id) ?? [])
        .map((id) => mailboxMap.get(id))
        .filter((mb): mb is NativeMailbox => !!mb && eligible(mb, campaign) && domainOpenFor(mb));
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

    // ---- Just-in-time email verification (Million Verifier) ----
    // Last gate before the send: every check that can stop this enrollment for
    // free (window, suppression, DNC, caps, mailbox slot, render, Gmail creds)
    // has already passed, so a credit is only ever spent on an address we would
    // send to right now. Fresh cached results (<=30d) send with no API call.
    // A hold leaves the enrollment active (retried next tick) and never consumes
    // the mailbox slot; a skip fails it terminally. gate.result is snapshotted
    // on the send row (null = gate disarmed / no key configured).
    const gate = await gateContactVerification({
      admin,
      state: verifierByOrg.get(campaign.organization_id) ?? null,
      contact,
      now: tickNow,
    });
    if (gate.action === "hold") {
      results.push({ enrollment_id: enrollment.id, result: `verify_hold_${gate.reason}` });
      continue;
    }
    if (gate.action === "skip") {
      await markEnrollmentFailed(admin, enrollment.id, `Email verification: ${gate.reason}`);
      results.push({ enrollment_id: enrollment.id, result: `verify_skip_${gate.status}` });
      continue;
    }

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
      email_verification_result: gate.result,
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
    lastSentTodayMs[mailbox.id] = tickNow.getTime();
    // Count this send against the domain's daily cap (no-op unless the domain
    // has one set).
    if (mailbox.domain_id && capByDomainId.has(mailbox.domain_id)) {
      domainInTick.set(mailbox.domain_id, (domainInTick.get(mailbox.domain_id) ?? 0) + 1);
    }
    // Count this first-touch against the campaign's new-leads/day cap.
    if (enrollment.current_step_index === 0) {
      newLeadsInTick[campaign.id] = (newLeadsInTick[campaign.id] ?? 0) + 1;
    }
    sent++;
    results.push({ enrollment_id: enrollment.id, result: hasNext ? "advanced" : "completed" });
  }

  // Persist per-org credit balance + error streak and enqueue edge-triggered
  // owner alerts (verifier down / credits low). Never throws. The returned
  // summary lands in the cron tally so a tick's verification activity
  // (armed/suppressed/tripped, calls, cached, held, skipped) is greppable.
  const verification = await finalizeVerifierStates(admin, verifierByOrg);

  return NextResponse.json({ status: "ok", sent, verification, results });
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
