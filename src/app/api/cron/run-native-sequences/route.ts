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
//      disposable are skipped, errors and a verifier outage HOLD (fail-closed),
//      and an address that stays "unknown" after three hourly retries sends
//      flagged risky (owner-confirmed policy, src/lib/millionverifier/policy.ts).
//      Then send the step, log it to native_sends, advance the enrollment.
//
// Pacing is at-most-once. There is no lock table or lease, but each step is
// CLAIMED with a compare-and-set on the enrollment's current_step_index right
// before the Gmail call (see claimStep below): Vercel documents that a second
// cron instance can start while one is running and that a scheduled run can
// occasionally be delivered twice, and the local cron-drive loop overlaps
// prod, so "one tick at a time" is not something the platform guarantees.
// Transient/rate-limit failures release the claim and leave the enrollment
// active for retry; permanent failures mark it failed.

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
import { loadVerifierStates, finalizeVerifierStates, VerifierStateLoadError } from "@/lib/millionverifier/org-state";
import { gateContactVerification } from "@/lib/millionverifier/verify-contact";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import { domainOpenForNewLeads } from "@/lib/deliverability/lifecycle";
import {
  resolveFlowAction,
  firstPrimaryEmail,
  type FlowSignals,
} from "@/lib/flow/runtime";
import { isAbTest, emailVariants, type FlowGraph } from "@/lib/flow/graph";
import { pickVariant } from "@/lib/flow/variants";
import { createManualTask, manualTaskKindForLinkedIn } from "@/lib/manual-tasks/create";
import { runInternalNode } from "@/lib/notifications/internal-automations";
import type {
  CampaignEnrollment,
  CampaignStep,
  Contact,
  DomainLifecycle,
  NativeMailbox,
  ReplyClass,
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
  // Visual Flow builder graph (migration 00086). NULL = legacy/linear campaign —
  // the sender walks campaign_steps by current_step_index exactly as before.
  // Present = the graph runtime (migration 00089) walks the tree from the
  // enrollment's current_node_id (branches + linkedin/internal nodes execute).
  flow_graph: FlowGraph | null;
};

// Result of the shared email-dispatch step (verify → send → log → count). The
// caller (linear or flow) applies its own enrollment ADVANCE on "sent" and the
// terminal effect on the failure variants. resultTag preserves the exact tick
// tally string; failReason is the enrollment.last_error to write on a failure.
type DispatchResult =
  | { status: "sent"; rfcMessageId: string; threadId: string }
  | { status: "hold"; resultTag: string }
  | { status: "retry"; resultTag: string }
  | { status: "mailbox_auth"; resultTag: string }
  | { status: "skip"; resultTag: string; failReason: string }
  | { status: "send_failed"; resultTag: string; failReason: string };

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

  // EVERY prefetch below checks its error and aborts the tick on failure. A
  // supabase-js call never throws; it returns { data: null, error }, and the
  // old `const { data } = ...` reads turned one transient DB error into an
  // empty map that the loop then read as "no step" (enrollment completed) or
  // "contact no longer exists" (enrollment failed, terminal) for up to 120
  // rows, or as "no DNC entries" (opted-out addresses mailed). Aborting with
  // a 500 costs one 5-minute tick; the old behaviour cost real leads
  // (SEND_RUNTIME_AUDIT.md SEND-50, SEND-53).
  const prefetchFailed = (what: string, err: { message?: string } | null) => {
    console.error(`[cron/native-sequences] ${what} prefetch failed; tick aborted:`, err);
    return NextResponse.json({ error: `${what} prefetch failed: ${err?.message ?? "unknown"}` }, { status: 500 });
  };

  // ---- 1. Eligible campaigns FIRST ----
  // Active native campaigns that are inside their own send window right now.
  // The old design fetched enrollments fleet-wide (two global 60-row windows
  // ordered oldest-first) and only THEN looked at the campaign, so rows from a
  // paused or draft campaign, or from a campaign outside its window, filled the
  // windows and were skipped in JS every tick while every other campaign
  // starved with `sent: 0` and no alert (SEND-35). Filtering campaigns first
  // and fetching per campaign removes that whole class.
  const { data: campaignsData, error: campaignsErr } = await admin
    .from("campaigns")
    .select("id, organization_id, client_id, status, source_channel, name, send_timezone, send_start_hour, send_end_hour, send_weekdays_only, daily_new_leads_cap, sending_strategy, flow_graph")
    .eq("source_channel", "native_email")
    .eq("status", "active");
  if (campaignsErr) return prefetchFailed("campaigns", campaignsErr);
  const campaignMap = new Map<string, CampaignRow>();
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
  for (const c of (campaignsData ?? []) as CampaignRow[]) {
    const inWindow = isInSendWindow(tickNow, windowFor(c));
    inWindowByCampaign.set(c.id, inWindow);
    if (inWindow) campaignMap.set(c.id, c);
  }
  if (campaignMap.size === 0) {
    return NextResponse.json({ status: "idle", reason: "no active campaign in its send window" });
  }
  const campaignIds = [...campaignMap.keys()];

  // ---- 2. Steps (needed to compute due-ness in SQL below) ----
  const { data: stepsData, error: stepsErr } = await admin
    .from("campaign_steps")
    .select("*")
    .in("campaign_id", campaignIds)
    .order("step_index", { ascending: true });
  if (stepsErr) return prefetchFailed("campaign_steps", stepsErr);
  const stepsByCampaign = new Map<string, Map<number, CampaignStep>>();
  for (const s of (stepsData ?? []) as CampaignStep[]) {
    let m = stepsByCampaign.get(s.campaign_id);
    if (!m) {
      m = new Map();
      stepsByCampaign.set(s.campaign_id, m);
    }
    m.set(s.step_index, s);
  }

  // A campaign runs the GRAPH runtime only when its flow_graph is a well-formed,
  // non-empty tree. A NULL / malformed / empty graph falls back to the LINEAR
  // path (campaign_steps by current_step_index), zero regression for every
  // legacy campaign, and a safety net if a stored graph is ever corrupt (the
  // derived campaign_steps still send). Parsed once per tick per campaign.
  const flowGraphByCampaign = new Map<string, FlowGraph>();
  for (const c of campaignMap.values()) {
    const g = c.flow_graph;
    if (g && typeof g === "object" && Array.isArray(g.nodes) && g.nodes.length > 0) {
      flowGraphByCampaign.set(c.id, g);
    }
  }

  // ---- 3. Mailboxes that cannot send (paused / error / rested) ----
  // A sticky follow-up parked on one of these is skipped every tick with its
  // sort key untouched, so it would sit at the head of the follow-up window
  // forever and crowd out live rows (SEND-35). Excluded in SQL instead.
  const { data: benchedRows, error: benchedErr } = await admin
    .from("native_mailboxes")
    .select("id")
    .neq("status", "active");
  if (benchedErr) return prefetchFailed("native_mailboxes (benched)", benchedErr);
  const benchedMailboxIds = ((benchedRows ?? []) as { id: string }[]).map((r) => r.id);

  // ---- 4. Enrollments, per eligible campaign, DUE rows only ----
  // Follow-ups and never-sent leads are fetched in SEPARATE capped queries per
  // campaign and combined (the per-campaign strategy sort below decides which
  // class wins the day's send slots). Due-ness is filtered in SQL: the old
  // fetch took the 60 oldest-actioned rows whether or not their wait had
  // elapsed, so long-wait rows occupied the window and due short-wait
  // follow-ups were never fetched (prod on 2026-09-05: 35 of 60 slots spent on
  // not-yet-due rows, 30 due follow-ups unfetched; SEND-62). Linear campaigns
  // get an exact per-step threshold; flow campaigns use the smallest wait in
  // the graph (conservative: never excludes a due row).
  const PER_CAMPAIGN_FETCH = SENDS_PER_TICK * 2;
  const isoNoMs = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const nowMs = tickNow.getTime();
  const DAY = 86_400_000;
  const perCampaign = await Promise.all(
    campaignIds.map(async (cid) => {
      const graph = flowGraphByCampaign.get(cid);
      const steps = stepsByCampaign.get(cid);
      let followups = admin
        .from("campaign_enrollments")
        .select("*")
        .eq("status", "active")
        .eq("campaign_id", cid)
        .not("last_action_at", "is", null)
        .order("last_action_at", { ascending: true })
        .limit(PER_CAMPAIGN_FETCH);
      let newLeads = admin
        .from("campaign_enrollments")
        .select("*")
        .eq("status", "active")
        .eq("campaign_id", cid)
        .is("last_action_at", null)
        .order("started_at", { ascending: true })
        .limit(PER_CAMPAIGN_FETCH);
      if (benchedMailboxIds.length > 0) {
        followups = followups.or(
          `native_mailbox_id.is.null,native_mailbox_id.not.in.(${benchedMailboxIds.join(",")})`,
        );
      }
      if (graph) {
        let minWait = Infinity;
        for (const n of graph.nodes) {
          const w = (n as { wait_days?: unknown }).wait_days;
          if (typeof w === "number" && w >= 0) minWait = Math.min(minWait, w);
        }
        if (Number.isFinite(minWait) && minWait > 0) {
          followups = followups.lte("last_action_at", isoNoMs(nowMs - minWait * DAY));
        }
      } else if (steps && steps.size > 0) {
        const clauses: string[] = [];
        let maxIndex = -1;
        for (const [idx, step] of steps) {
          maxIndex = Math.max(maxIndex, idx);
          if (idx === 0) continue; // step 0 is a new lead (last_action_at null)
          const wait = Math.max(0, Number(step.wait_days) || 0);
          clauses.push(
            `and(current_step_index.eq.${idx},last_action_at.lte.${isoNoMs(nowMs - wait * DAY)})`,
          );
        }
        // Rows past the last step are fetched so the loop can complete them.
        clauses.push(`current_step_index.gt.${maxIndex}`);
        followups = followups.or(clauses.join(","));
        const step0Wait = Math.max(0, Number(steps.get(0)?.wait_days) || 0);
        if (step0Wait > 0) newLeads = newLeads.lte("started_at", isoNoMs(nowMs - step0Wait * DAY));
      }
      const [f, n] = await Promise.all([followups, newLeads]);
      return { cid, f, n };
    }),
  );
  const enrollments: EnrollmentRow[] = [];
  for (const { cid, f, n } of perCampaign) {
    if (f.error) return prefetchFailed(`enrollments (follow-ups, campaign ${cid})`, f.error);
    if (n.error) return prefetchFailed(`enrollments (new leads, campaign ${cid})`, n.error);
    enrollments.push(
      ...((f.data ?? []) as unknown as EnrollmentRow[]),
      ...((n.data ?? []) as unknown as EnrollmentRow[]),
    );
  }
  if (enrollments.length === 0) {
    return NextResponse.json({ status: "idle" });
  }

  // ---- Bulk prefetch everything the loop needs ----
  const contactIds = [...new Set(enrollments.map((e) => e.contact_id))];

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

  const { data: contactsData, error: contactsErr } = await admin
    .from("contacts")
    .select("*")
    .in("id", contactIds);
  if (contactsErr) return prefetchFailed("contacts", contactsErr);
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
    const { data: dncRows, error: dncErr } = await admin
      .from("dnc_entries")
      .select("client_id, email")
      .in("organization_id", orgIds)
      .in("email", dncEmails);
    // A failed DNC read must never read as "nobody opted out" (SEND-53).
    if (dncErr) return prefetchFailed("dnc_entries", dncErr);
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

  // Per-client DNC test. A campaign with NO client (unlinked while live, or an
  // org-internal one) used to check only the org-wide "*" entries, so a
  // client-scoped opt-out recorded while it was linked stopped suppressing it
  // (SEND-55). With no client to scope to, ANY entry for the address suppresses.
  const isDncSuppressed = (emailKey: string, campaign: CampaignRow): boolean => {
    const dncClients = dncByEmail.get(emailKey);
    if (!dncClients || dncClients.size === 0) return false;
    if (campaign.client_id == null) return true;
    return dncClients.has(campaign.client_id) || dncClients.has("*");
  };

  // ---- Flow-runtime reply signal ----
  // A flow `condition` node can branch on the reply — its existence (`replied`)
  // OR its classifier sentiment (`reply_interested` / `_objection` / …), read
  // from lead_replies.final_class. lead_replies has no contact_id, so we key by
  // campaign_id + the contact's email. Presence in the map = replied; value = the
  // LATEST reply's final_class (null if unclassified). Only queried when a flow
  // campaign is in this tick's batch; bounces use contact.status. Key:
  // `${campaign_id}\n${lowercased email}`.
  const replyClassByKey = new Map<string, ReplyClass | null>();
  if (flowGraphByCampaign.size > 0) {
    const flowCampaignIds = [...flowGraphByCampaign.keys()];
    const emailCandidates = new Set<string>();
    for (const e of enrollments) {
      if (!flowGraphByCampaign.has(e.campaign_id)) continue;
      const em = contactMap.get(e.contact_id)?.email?.trim();
      if (em) {
        emailCandidates.add(em);
        emailCandidates.add(em.toLowerCase());
      }
    }
    if (emailCandidates.size > 0) {
      const { data: replyRows } = await admin
        .from("lead_replies")
        .select("campaign_id, lead_email, final_class, received_at")
        .in("campaign_id", flowCampaignIds)
        .in("lead_email", [...emailCandidates])
        .order("received_at", { ascending: false });
      for (const r of (replyRows ?? []) as {
        campaign_id: string | null;
        lead_email: string | null;
        final_class: ReplyClass | null;
        received_at: string | null;
      }[]) {
        if (!r.campaign_id || !r.lead_email) continue;
        const key = `${r.campaign_id}\n${r.lead_email.trim().toLowerCase()}`;
        // Rows are newest-first, so the FIRST sighting of a key is the latest reply.
        if (!replyClassByKey.has(key)) replyClassByKey.set(key, r.final_class ?? null);
      }
    }
  }

  // ---- Sticky A/B assignment for threading ----
  // A follow-up with an empty subject threads as "Re: <first email subject>",
  // rendered from the variant THIS contact received on the first email. Once the
  // auto-winner pauses a variant, freshly re-deriving that assignment would drop
  // the paused one and could flip a lead already mid-thread — so we read the
  // variant they were ACTUALLY sent (native_sends.variant_id at step 0) and stay
  // on it. Keyed `${campaign_id}\n${contact_id}`; only the first-email A/B case
  // consults it, and only flow campaigns are in this tick's fetch set.
  const firstVariantByContact = new Map<string, string>();
  if (flowGraphByCampaign.size > 0) {
    const { data: fvRows } = await admin
      .from("native_sends")
      .select("campaign_id, contact_id, variant_id")
      .in("campaign_id", [...flowGraphByCampaign.keys()])
      .in("contact_id", contactIds)
      .eq("step_index", 0)
      .not("variant_id", "is", null);
    for (const r of (fvRows ?? []) as {
      campaign_id: string | null;
      contact_id: string | null;
      variant_id: string | null;
    }[]) {
      if (!r.campaign_id || !r.contact_id || !r.variant_id) continue;
      const key = `${r.campaign_id}\n${r.contact_id}`;
      if (!firstVariantByContact.has(key)) firstVariantByContact.set(key, r.variant_id);
    }
  }

  // Per-org Million Verifier state for this tick: the client (null = gate
  // disarmed when no key is configured), the 1h suppression window carried over
  // from a definitive account error, and the per-tick breaker + tallies the
  // gate mutates as it runs. A missing-column error (migration 00069 not yet
  // applied) disarms the gate rather than throwing — sends proceed unverified.
  // Fail closed: if the verifier state cannot be read, nothing sends this tick
  // (SEND-51). The only surviving disarm is the pre-00069 missing-column case.
  let verifierByOrg: Awaited<ReturnType<typeof loadVerifierStates>>;
  try {
    verifierByOrg = await loadVerifierStates(admin, orgIds, tickNow);
  } catch (err) {
    if (err instanceof VerifierStateLoadError) {
      return prefetchFailed("verifier state", { message: err.message });
    }
    throw err;
  }

  // Campaign → mailbox pool.
  const { data: poolData, error: poolErr } = await admin
    .from("campaign_mailboxes")
    .select("campaign_id, mailbox_id")
    .in("campaign_id", campaignIds);
  if (poolErr) return prefetchFailed("campaign_mailboxes", poolErr);
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
    const { data: mbData, error: mbErr } = await admin
      .from("native_mailboxes")
      .select("*")
      .in("id", [...referencedMailboxIds]);
    if (mbErr) return prefetchFailed("native_mailboxes", mbErr);
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
    // Paged: PostgREST silently truncates an un-ranged select at max_rows
    // (1,000 on this project, verified live), and past ~50 inboxes a day's
    // sends exceed that, so the tail mailboxes would read as 0 sent today and
    // blow through their caps (SEND-68). Page until a short page comes back.
    const PAGE = 1000;
    const sendRows: { mailbox_id: string; sent_at: string | null }[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data: page, error: sendsErr } = await admin
        .from("native_sends")
        .select("mailbox_id, sent_at")
        .in("mailbox_id", [...referencedMailboxIds])
        .gte("sent_at", dayStart)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (sendsErr) return prefetchFailed("native_sends (today)", sendsErr);
      const rows = (page ?? []) as { mailbox_id: string; sent_at: string | null }[];
      sendRows.push(...rows);
      if (rows.length < PAGE) break;
    }
    for (const s of sendRows) {
      sentToday[s.mailbox_id] = (sentToday[s.mailbox_id] ?? 0) + 1;
      if (s.sent_at) {
        const t = Date.parse(s.sent_at);
        if (!(s.mailbox_id in lastSentTodayMs) || t > lastSentTodayMs[s.mailbox_id]) {
          lastSentTodayMs[s.mailbox_id] = t;
        }
      }
    }
  }

  // Frozen copy of the day's counts at tick start: the ramp cap must be derived
  // from the START-of-day cumulative count, not the live one, or a mailbox
  // that graduates mid-day sends cap+1 that day (SEND-66).
  const sentTodayStart: Record<string, number> = { ...sentToday };

  // New leads (step-0 first-touches) already sent today, per campaign — drives
  // the per-campaign daily new-leads cap. Follow-ups are not counted here.
  const newLeadsToday: Record<string, number> = {};
  {
    const { data: newLeadRows, error: newLeadErr } = await admin
      .from("native_sends")
      .select("campaign_id")
      .in("campaign_id", campaignIds)
      .eq("step_index", 0)
      .gte("sent_at", dayStart);
    if (newLeadErr) return prefetchFailed("native_sends (new leads today)", newLeadErr);
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
  // (windowFor / inWindowByCampaign are resolved once per campaign in step 1
  // above, before the enrollment fetch, so out-of-window campaigns are never
  // fetched at all.)

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
  // The day's cap is fixed at the start of the day: graduation thresholds equal
  // the cumulative caps, so reading the LIVE count let an inbox graduate after
  // its 5th send and fire a 6th the same afternoon (SEND-66). Subtracting the
  // start-of-day count pins the cap to the stage the inbox woke up in.
  const rampSentAtDayStart = (mb: NativeMailbox) =>
    Math.max(0, rampSent(mb) - (sentTodayStart[mb.id] ?? 0));
  const remaining = (mb: NativeMailbox) =>
    effectiveDailyCap(mb, rampSentAtDayStart(mb)) - (sentToday[mb.id] ?? 0) - (inTick[mb.id] ?? 0);
  // Rotation load: how many this inbox has already sent today (persisted + this
  // tick). The step-0 pool pick orders by this ASC so first-touches spread
  // EVENLY across a campaign's inboxes — a freshly-added or smaller-cap inbox
  // actually receives traffic and warms up. (The prior "most-remaining-first"
  // greedy let a warmed high-cap inbox absorb every send in a low-volume
  // campaign, so a new inbox never sent and its ramp never advanced. Cap
  // eligibility still stops any inbox exceeding its own daily cap.)
  const load = (mb: NativeMailbox) => (sentToday[mb.id] ?? 0) + (inTick[mb.id] ?? 0);
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

  // ── Step claim (at-most-once under overlapping ticks) ──────────────────────
  // The header's "at-most-once with no locking" stance was tested against
  // Vercel's own docs (read 2026-09-05): a second instance CAN run while the
  // first is still running, and "the same scheduled run" can occasionally be
  // invoked twice. The documented local cron-drive loop adds a third overlap
  // source. Two overlapping ticks fetched the same rows, passed every gate off
  // the same snapshot, and both called gmail.sendMessage before either wrote,
  // so a lead got the same step twice (SEND-64). The claim is a compare-and-
  // set on current_step_index right before the send: the loser of the race
  // sees 0 rows updated and skips. No lock table, no lease column, no
  // migration; a claim that then fails to send is released (rolled back) on
  // hold / retry / auth / config outcomes. If the function dies between claim
  // and send, that ONE step is skipped for that lead (never sent twice), which
  // is the documented trade-off: a missed email beats a duplicate.
  async function claimStep(enr: EnrollmentRow, stepIndex: number): Promise<boolean> {
    const { data, error } = await admin
      .from("campaign_enrollments")
      .update({ current_step_index: stepIndex + 1, last_action_at: new Date().toISOString() })
      .eq("id", enr.id)
      .eq("status", "active")
      .eq("current_step_index", stepIndex)
      .select("id");
    if (error) {
      console.error("[cron/native-sequences] step claim failed for", enr.id, error.message);
      return false;
    }
    return (data ?? []).length > 0;
  }
  async function releaseStep(enr: EnrollmentRow, stepIndex: number): Promise<void> {
    const { error } = await admin
      .from("campaign_enrollments")
      .update({ current_step_index: stepIndex, last_action_at: enr.last_action_at })
      .eq("id", enr.id)
      .eq("current_step_index", stepIndex + 1);
    if (error) console.error("[cron/native-sequences] step release failed for", enr.id, error.message);
  }
  // Post-send advance. The claim already moved current_step_index; this writes
  // the thread ids + mailbox binding. Guarded on status=active so a poller
  // `replied` that landed mid-tick is never clobbered back to active
  // (SEND-43), and CHECKED: an unchecked failure here used to leave the row
  // pointing at the previous step and re-send it next slot (SEND-65). One
  // retry, then a loud log; the claim guarantees no re-send either way.
  async function writeAdvance(
    enrollmentId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { error } = await admin
        .from("campaign_enrollments")
        .update(patch)
        .eq("id", enrollmentId)
        .eq("status", "active");
      if (!error) return;
      console.error(
        `[cron/native-sequences] post-send advance failed (attempt ${attempt}) for ${enrollmentId}:`,
        error.message,
      );
    }
  }

  // Permanent (4xx) send failures per mailbox this tick. Three benches the
  // inbox: that many distinct recipients rejected by the same inbox in one
  // tick is a mailbox problem, not a lead problem (SEND-20).
  const permanentFailuresInTick: Record<string, number> = {};
  const MAILBOX_BENCH_AFTER_PERMANENT_FAILURES = 3;

  // Bench a mailbox: status=error + reason, mirrored in memory so eligible()
  // skips it for the rest of the tick, plus an owner alert. The bench used to
  // be silent; the poller also stops polling an `error` inbox, so nobody knew
  // replies to its threads were no longer being read (SEND-38).
  async function benchMailbox(mb: NativeMailbox, organizationId: string, reason: string): Promise<void> {
    const { error } = await admin
      .from("native_mailboxes")
      .update({ status: "error", last_error: reason, last_error_at: new Date().toISOString() })
      .eq("id", mb.id);
    if (error) console.error("[cron/native-sequences] bench write failed for", mb.email_address, error.message);
    mb.status = "error";
    await enqueueOwnerAlert({
      admin,
      kind: "mailbox_benched",
      subject: `Mailbox ${mb.email_address} benched by the sender`,
      summary:
        `${mb.email_address} was set to "error" and stopped sending: ${reason}. ` +
        `Its in-flight follow-ups wait until it is re-activated on the Mailboxes page.`,
      context: { organization_id: organizationId, mailbox: mb.email_address, reason },
    });
  }

  // Send, and if Gmail says the stored thread no longer exists (404 on a send
  // that carried a threadId: the user emptied Trash mid-sequence), retry once
  // as a fresh thread instead of permanently failing the lead (SEND-23). The
  // In-Reply-To/References headers still thread it on the recipient's side.
  async function sendWithThreadFallback(
    client: GmailClient,
    from: string,
    raw: string,
    threadId: string | undefined,
  ): Promise<{ id: string; threadId: string }> {
    try {
      return await client.sendMessage(from, raw, threadId);
    } catch (err) {
      if (threadId && err instanceof GmailPermanentError && err.status === 404) {
        console.warn(`[cron/native-sequences] thread ${threadId} gone for ${from}; sending as a new thread`);
        return await client.sendMessage(from, raw, undefined);
      }
      throw err;
    }
  }

  // ── Shared email dispatch ───────────────────────────────────────────────────
  // verify → build → send → read back Message-ID → log to native_sends → bump
  // mailbox/domain/new-lead counters + flip the contact live. Does NOT advance
  // the enrollment (linear and flow advance differently). BOTH paths funnel
  // through here so the send mechanics can never drift between them.
  async function dispatchEmail(args: {
    campaign: CampaignRow;
    enrollment: EnrollmentRow;
    contact: Contact;
    mailbox: NativeMailbox;
    gmail: GmailClient;
    subject: string;
    bodyText: string;
    stepIndex: number;
    inReplyTo: string | null;
    references: string | null;
    variantId?: string | null; // A/B variant this send used (null = single-variant)
  }): Promise<DispatchResult> {
    const { campaign, enrollment, contact, mailbox, gmail, subject, bodyText, stepIndex, inReplyTo, references } = args;
    const to = contact.email as string; // caller guarantees a non-empty address

    // Just-in-time email verification (Million Verifier). A hold leaves the
    // enrollment active (retried next tick) and never consumes the mailbox slot;
    // a skip fails it terminally. gate.result is snapshotted on the send row.
    const gate = await gateContactVerification({
      admin,
      state: verifierByOrg.get(campaign.organization_id) ?? null,
      contact,
      now: tickNow,
    });
    if (gate.action === "hold") {
      return { status: "hold", resultTag: `verify_hold_${gate.reason}` };
    }
    if (gate.action === "skip") {
      return {
        status: "skip",
        resultTag: `verify_skip_${gate.status}`,
        failReason: `Email verification: ${gate.reason}`,
      };
    }

    const messageId = generateMessageId(mailbox.email_address);
    const raw = buildRawEmail({
      fromEmail: mailbox.email_address,
      fromName: mailbox.display_name,
      to,
      subject,
      bodyText,
      messageId,
      inReplyTo,
      references,
    });

    let sendResult: { id: string; threadId: string };
    try {
      sendResult = await sendWithThreadFallback(
        gmail,
        mailbox.email_address,
        raw,
        enrollment.gmail_thread_id ?? undefined,
      );
    } catch (err) {
      if (err instanceof GmailAuthError) {
        // Delegation broke for this mailbox: bench it (skips its enrollments the
        // rest of the tick via eligible()) and leave the enrollment active.
        // Quota 403s are classified as rate limits by the client now, so this
        // is a real permission failure (SEND-19).
        await benchMailbox(mailbox, campaign.organization_id, `Delegation error: ${err.message}`);
        return { status: "mailbox_auth", resultTag: "mailbox_auth_error" };
      }
      if (err instanceof GmailRateLimitError || err instanceof GmailTransientError) {
        return { status: "retry", resultTag: "retry_later" };
      }
      if (err instanceof GmailConfigError) {
        // Org-level service-account problem, nothing to do with this lead or
        // this mailbox: stop using the org's client for the rest of the tick and
        // leave the enrollment active (SEND-21).
        console.error("[cron/native-sequences] Gmail config error for org", campaign.organization_id, err.message);
        gmailByOrg.set(campaign.organization_id, null);
        return { status: "retry", resultTag: "gmail_config_error" };
      }
      // Permanent 4xx. Fail the enrollment as before, but COUNT it against the
      // mailbox: a mailbox-level 400 (mail service disabled, suspended user)
      // used to fail every lead routed to that inbox one after another inside
      // a single tick, while the inbox stayed "active" and least-loaded so the
      // pool kept picking it (SEND-20). Three in one tick benches it.
      const msg = err instanceof Error ? err.message : String(err);
      const n = (permanentFailuresInTick[mailbox.id] ?? 0) + 1;
      permanentFailuresInTick[mailbox.id] = n;
      if (n >= MAILBOX_BENCH_AFTER_PERMANENT_FAILURES && mailbox.status === "active") {
        await benchMailbox(
          mailbox,
          campaign.organization_id,
          `${n} permanent Gmail send failures in one tick; last: ${msg}`,
        );
      }
      return { status: "send_failed", resultTag: "failed_send", failReason: `Send failed: ${msg}` };
    }

    // Read back the authoritative Message-ID for threading (non-fatal on failure).
    let rfcMessageId = messageId;
    try {
      const meta = await gmail.getMessage(mailbox.email_address, sendResult.id, "metadata", ["Message-ID"]);
      const hdr = meta.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id");
      if (hdr?.value) rfcMessageId = hdr.value;
    } catch {
      // Fall back to the generated Message-ID; threadId still threads.
    }

    // The send log is load-bearing: the daily cap, the ramp, the new-leads cap
    // and the reply poller's thread match all read native_sends. A silently
    // failed insert hid a real send from every one of them (SEND-65), so the
    // insert is checked and retried once, then logged loudly.
    const sendRow = {
      organization_id: campaign.organization_id,
      campaign_id: campaign.id,
      contact_id: contact.id,
      enrollment_id: enrollment.id,
      mailbox_id: mailbox.id,
      step_index: stepIndex,
      to_email: to,
      email_verification_result: gate.result,
      variant_id: args.variantId ?? null,
      rfc_message_id: rfcMessageId,
      gmail_message_id: sendResult.id,
      gmail_thread_id: sendResult.threadId,
      status: "sent",
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { error: logErr } = await admin.from("native_sends").insert(sendRow);
      if (!logErr) break;
      console.error(
        `[cron/native-sequences] native_sends insert failed (attempt ${attempt}) for enrollment ${enrollment.id} gmail ${sendResult.id}:`,
        logErr.message,
      );
    }

    // First send flips a queued/new contact to 'active' (it's now sending).
    if (stepIndex === 0) {
      await admin
        .from("contacts")
        .update({ status: "active" })
        .eq("id", contact.id)
        .in("status", ["new", "enriched", "queued", "uploaded"]);
    }

    sentToday[mailbox.id] = (sentToday[mailbox.id] ?? 0) + 1;
    inTick[mailbox.id] = (inTick[mailbox.id] ?? 0) + 1;
    lastSentTodayMs[mailbox.id] = tickNow.getTime();
    if (mailbox.domain_id && capByDomainId.has(mailbox.domain_id)) {
      domainInTick.set(mailbox.domain_id, (domainInTick.get(mailbox.domain_id) ?? 0) + 1);
    }
    if (stepIndex === 0) {
      newLeadsInTick[campaign.id] = (newLeadsInTick[campaign.id] ?? 0) + 1;
    }

    return { status: "sent", rfcMessageId, threadId: sendResult.threadId };
  }

  // Advance a flow enrollment past a non-email node (linkedin / internal). Sets
  // last_action_at so later waits measure from this action; does NOT bump
  // current_step_index (that counts EMAILS only).
  async function advanceFlowNode(enr: EnrollmentRow, nodeId: string): Promise<void> {
    await admin
      .from("campaign_enrollments")
      .update({
        current_node_id: nodeId,
        last_action_at: new Date().toISOString(),
        last_error: null,
        status: "active",
      })
      .eq("id", enr.id);
  }

  // ── Flow-graph runtime: one enrollment, one due tick ────────────────────────
  // Walk campaigns.flow_graph from the enrollment's current_node_id and perform
  // the next actionable node: email → dispatchEmail (identical mechanics to the
  // linear path), linkedin → a manual VA task, internal → the notify/webhook
  // helper. Conditions route on real signals (see resolveFlowAction). Returns a
  // tick-tally descriptor; `emailSent`/`sideAction` feed the per-tick budget.
  async function runFlowEnrollment(
    graph: FlowGraph,
    enrollment: EnrollmentRow,
    campaign: CampaignRow,
  ): Promise<{ result: string; emailSent?: boolean; sideAction?: boolean }> {
    const contact = contactMap.get(enrollment.contact_id);
    if (!contact) {
      await markEnrollmentFailed(admin, enrollment.id, "Contact no longer exists.");
      return { result: "failed_no_contact" };
    }

    // Condition signals (per campaign+contact). hasReplied is the HUMAN-reply halt
    // signal: contact.status==='replied', which the reply poller sets ONLY for
    // non-auto replies — so an out-of-office / auto-reply never halts the sequence
    // (it still writes a lead_replies row, which we read as replyClass). replyClass
    // = the latest ingested reply's class (incl. 'ooo'), driving the reply_*
    // sentiment triggers. bounced = contact.status. opened/clicked/manual → NO.
    const emailKey = (contact.email ?? "").trim().toLowerCase();
    const replyKey = `${campaign.id}\n${emailKey}`;
    const hasReplied = contact.status === "replied";
    const hasBounced = contact.status === "bounced";
    const signals: FlowSignals = {
      hasReplied,
      hasBounced,
      replyClass: emailKey.length > 0 ? replyClassByKey.get(replyKey) ?? null : null,
    };

    const action = resolveFlowAction(
      graph,
      { currentNodeId: enrollment.current_node_id ?? null, emailsSent: enrollment.current_step_index },
      signals,
    );

    if (action.type === "complete") {
      await admin.from("campaign_enrollments").update({ status: "completed" }).eq("id", enrollment.id);
      return { result: "completed" };
    }

    // Wait gate — accumulated across the walk, measured from the last action (or
    // enrollment start for the first). Checked BEFORE the reply-halt, matching
    // the linear path (a reply is acted on only once the next step is due).
    const referenceTime = enrollment.last_action_at ?? enrollment.started_at;
    if (action.waitDays > 0 && referenceTime) {
      const dueAt = new Date(referenceTime).getTime() + action.waitDays * 86_400_000;
      if (Date.now() < dueAt) return { result: "flow_wait" };
    }

    // Reply-halt reconciliation: if the contact replied and NO reply-family
    // condition MATCHED en route to this action, halt the enrollment exactly as
    // the linear sender does (a human takes over) — this also fail-safes an
    // unhandled reply CLASS (replied, but no matching sentiment branch routed
    // them). When a reply condition did match, the graph is handling the reply so
    // we don't pre-empt. Applies to EVERY action type.
    if (hasReplied && !action.matchedReplyRoute) {
      await admin.from("campaign_enrollments").update({ status: "replied" }).eq("id", enrollment.id);
      return { result: "already_replied" };
    }
    // Unsubscribe is a hard opt-out across channels — stop the enrollment.
    if (contact.status === "unsubscribed") {
      await markEnrollmentFailed(admin, enrollment.id, "Contact is unsubscribed.");
      return { result: "suppressed_unsubscribed" };
    }

    // ---- LinkedIn node → a manual VA task, then advance past it. ----
    if (action.type === "linkedin") {
      const renderedBody = renderTemplate(action.node.body ?? "", contact, null, `${contact.id}:${action.node.id}:li`);
      const task = await createManualTask(admin, {
        organizationId: campaign.organization_id,
        campaignId: campaign.id,
        contactId: contact.id,
        kind: manualTaskKindForLinkedIn(action.node.li_kind),
        renderedBody,
        clientId: campaign.client_id,
        flowNodeId: action.node.id, // idempotency: one task per node per contact
      });
      if (task.error) {
        // Best-effort insert failed — leave parked and retry next tick.
        console.error("[cron/native-sequences] manual-task insert failed:", task.error);
        return { result: "flow_linkedin_error" };
      }
      await advanceFlowNode(enrollment, action.node.id);
      return { result: task.created ? "flow_linkedin_task" : "flow_linkedin_dedup", sideAction: true };
    }

    // ---- Internal node → notify/webhook (best-effort), then advance. ----
    if (action.type === "internal") {
      await runInternalNode(
        { id: action.node.id, action: action.node.action, label: action.node.label, target: action.node.target },
        {
          admin,
          organizationId: campaign.organization_id,
          campaignId: campaign.id,
          contactId: contact.id,
          clientId: campaign.client_id,
        },
      );
      await advanceFlowNode(enrollment, action.node.id);
      return { result: "flow_internal", sideAction: true };
    }

    // ---- Email node → the shared dispatch path. ----
    if (!contact.email) {
      await markEnrollmentFailed(admin, enrollment.id, "Contact has no email address.");
      return { result: "failed_no_email" };
    }
    // Bounce + DNC are EMAIL-only suppressions (a dead address / an email opt-out);
    // a bounced-condition can still route a bounced contact to a non-email arm
    // above, before this check is reached.
    if (hasBounced) {
      await markEnrollmentFailed(admin, enrollment.id, "Contact is bounced.");
      return { result: "suppressed_bounced" };
    }
    if (isDncSuppressed(emailKey, campaign)) {
      await markEnrollmentFailed(admin, enrollment.id, "Contact is on the client's DNC list.");
      return { result: "suppressed_dnc" };
    }

    const stepIndex = enrollment.current_step_index; // # emails already sent = this email's index
    const isFirst = stepIndex === 0;

    // Per-campaign new-leads/day gate for the first touch (identical to linear).
    if (isFirst) {
      const newLeadCap = resolveDailyNewLeadsCap(campaign);
      if (newLeadCap <= 0) return { result: "new_leads_paused" };
      if (resolveSendingStrategy(campaign) === "finish_first") {
        const usedNewLeads = (newLeadsToday[campaign.id] ?? 0) + (newLeadsInTick[campaign.id] ?? 0);
        if (usedNewLeads >= newLeadCap) return { result: "new_leads_cap_reached" };
      }
    }

    // Mailbox pick — sticky after the first send, else least-loaded open mailbox
    // in the pool (identical policy to the linear path). A mid-thread orphan
    // (sticky inbox deleted, thread ids kept) is failed, never re-homed (SEND-36).
    if (!enrollment.native_mailbox_id && enrollment.gmail_thread_id) {
      await markEnrollmentFailed(admin, enrollment.id, "Sending mailbox was deleted mid-sequence.");
      return { result: "failed_mailbox_deleted" };
    }
    let mailbox: NativeMailbox | undefined;
    if (enrollment.native_mailbox_id) {
      mailbox = mailboxMap.get(enrollment.native_mailbox_id);
      if (!mailbox || !eligible(mailbox, campaign)) return { result: "flow_mailbox_wait" };
    } else {
      const pool = (poolByCampaign.get(campaign.id) ?? [])
        .map((id) => mailboxMap.get(id))
        .filter((mb): mb is NativeMailbox => !!mb && eligible(mb, campaign) && domainOpenFor(mb));
      if (pool.length === 0) return { result: "flow_no_mailbox" };
      pool.sort((a, b) => load(a) - load(b) || remaining(b) - remaining(a) || a.id.localeCompare(b.id));
      mailbox = pool[0];
    }

    // A/B: deterministically assign this contact a variant (sticky). A single-
    // variant node just yields variant A (the node's own subject/body) and a null
    // variantId, so native_sends records it as a normal (non-A/B) send.
    const variant = pickVariant(action.node, contact.id);
    const variantId = isAbTest(action.node) ? variant.id : null;

    // Render subject + body from the chosen variant.
    const bodyText = renderTemplate(variant.body ?? "", contact, mailbox, `${contact.id}:${stepIndex}:body`);
    if (!bodyText) {
      await markEnrollmentFailed(admin, enrollment.id, "Rendered email body is empty.");
      return { result: "failed_empty_body" };
    }
    let subject: string;
    if (isFirst) {
      subject = renderTemplate(variant.subject ?? "", contact, mailbox, `${contact.id}:0:subject`);
      if (!subject) {
        await markEnrollmentFailed(admin, enrollment.id, "First email has no subject.");
        return { result: "failed_no_subject" };
      }
    } else if ((variant.subject ?? "").trim()) {
      subject = renderTemplate(variant.subject ?? "", contact, mailbox, `${contact.id}:${stepIndex}:subject`);
    } else {
      // Re: fallback — thread on the first primary-path email's subject as THIS
      // contact received it (their assigned variant), rendered with the step-0
      // seed key so it's byte-identical to the original send. Prefer the variant
      // they were ACTUALLY sent (sticky) so an auto-pause since then can't flip
      // the thread's subject; fall back to a fresh pick when unrecorded.
      const firstEmail = firstPrimaryEmail(graph);
      let firstVariant = firstEmail ? pickVariant(firstEmail, contact.id) : null;
      if (firstEmail) {
        const recordedId = firstVariantByContact.get(`${campaign.id}\n${contact.id}`);
        if (recordedId) {
          const sticky = emailVariants(firstEmail).find((v) => v.id === recordedId);
          if (sticky) firstVariant = sticky;
        }
      }
      const baseSubject =
        renderTemplate(firstVariant?.subject ?? "", contact, mailbox, `${contact.id}:0:subject`) || "(no subject)";
      subject = baseSubject.toLowerCase().startsWith("re:") ? baseSubject : `Re: ${baseSubject}`;
    }

    // Gmail client for the org (cached per tick).
    if (!gmailByOrg.has(campaign.organization_id)) {
      try {
        gmailByOrg.set(campaign.organization_id, await loadGmailClientForOrg(admin, campaign.organization_id));
      } catch (err) {
        gmailByOrg.set(campaign.organization_id, null);
        console.error("[cron/native-sequences] no Gmail creds for org", campaign.organization_id, err);
      }
    }
    const gmail = gmailByOrg.get(campaign.organization_id);
    if (!gmail) return { result: "flow_no_gmail" }; // org not configured; leave active

    // Claim the step (same CAS as the linear path) before the send.
    if (!(await claimStep(enrollment, stepIndex))) return { result: "claimed_elsewhere" };
    const d = await dispatchEmail({
      campaign,
      enrollment,
      contact,
      mailbox,
      gmail,
      subject,
      bodyText,
      stepIndex,
      inReplyTo: isFirst ? null : enrollment.last_rfc_message_id,
      references: isFirst ? null : enrollment.last_rfc_message_id,
      variantId,
    });
    if (d.status === "hold" || d.status === "retry" || d.status === "mailbox_auth") {
      await releaseStep(enrollment, stepIndex);
      return { result: d.resultTag };
    }
    if (d.status === "skip" || d.status === "send_failed") {
      await markEnrollmentFailed(admin, enrollment.id, d.failReason);
      return { result: d.resultTag };
    }
    // Sent: advance PAST this email node (current_node_id = node.id) and bump the
    // email counter. Stay 'active'; completion is detected on the next tick (when
    // the walk runs off the end), so a late reply can still re-route until then.
    await writeAdvance(enrollment.id, {
      current_node_id: action.node.id,
      current_step_index: stepIndex + 1,
      last_action_at: new Date().toISOString(),
      native_mailbox_id: mailbox.id,
      gmail_thread_id: d.threadId,
      last_rfc_message_id: d.rfcMessageId,
      last_error: null,
      status: "active",
    });
    return { result: "flow_email_sent", emailSent: true };
  }

  let sent = 0;
  // Non-email flow side-effects (linkedin tasks / internal notifies) this tick.
  // Shares the per-tick action budget with `sent` so a tick can't fan out an
  // unbounded number of outbound webhooks / task inserts.
  let sideActions = 0;
  const results: Array<{ enrollment_id: string; result: string }> = [];

  // Wall-clock guard: every Google call now has a 10s ceiling, but twenty
  // sends of two calls each can still outrun the 60s function. Stop
  // dispatching at 40s so the tick returns cleanly with everything it did
  // logged, instead of being killed mid-send (SEND-34 / SEND-64).
  const loopDeadlineMs = tickNow.getTime() + 40_000;
  let deadlineHit = false;

  for (const enrollment of enrollments) {
    if (sent + sideActions >= SENDS_PER_TICK) break;
    if (Date.now() > loopDeadlineMs) {
      deadlineHit = true;
      break;
    }

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

    // ── Flow campaigns: walk the graph (branches + linkedin/internal execute).
    // Legacy/linear campaigns (flow_graph NULL) fall through to the unchanged
    // step-index path below. This branch is the ONLY behavioral difference.
    const flowGraph = flowGraphByCampaign.get(campaign.id);
    if (flowGraph) {
      const outcome = await runFlowEnrollment(flowGraph, enrollment, campaign);
      results.push({ enrollment_id: enrollment.id, result: outcome.result });
      if (outcome.emailSent) sent++;
      if (outcome.sideAction) sideActions++;
      continue;
    }

    const steps = stepsByCampaign.get(campaign.id);
    // A campaign with NO steps at all is never "finished": the step editor
    // replaces steps with a delete-all then insert (no transaction), so a tick
    // landing in that gap, or a failed insert, used to mark every due
    // enrollment completed for good (SEND-39). Skip and retry next tick.
    if (!steps || steps.size === 0) {
      results.push({ enrollment_id: enrollment.id, result: "no_steps_wait" });
      continue;
    }
    const step = steps.get(enrollment.current_step_index);
    if (!step) {
      await admin
        .from("campaign_enrollments")
        .update({ status: "completed" })
        .eq("id", enrollment.id)
        .eq("status", "active");
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
      // A contact who replied to an EARLIER campaign and was then enrolled here
      // never got an email from this campaign, so "replied" would inflate this
      // campaign's reply metrics (SEND-40). Fail it with the reason instead;
      // an enrollment that already sent at least once really did get a reply.
      if (enrollment.current_step_index === 0 && !enrollment.last_action_at) {
        await markEnrollmentFailed(admin, enrollment.id, "Contact had already replied before this campaign sent anything.");
        results.push({ enrollment_id: enrollment.id, result: "suppressed_prior_reply" });
        continue;
      }
      await admin
        .from("campaign_enrollments")
        .update({ status: "replied" })
        .eq("id", enrollment.id)
        .eq("status", "active");
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
    if (isDncSuppressed(emailKey, campaign)) {
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
    // A mid-thread enrollment whose sticky mailbox is gone (the inbox was
    // deleted: the FK SET-NULLs the pointer but the thread ids stay) must not
    // be re-homed onto another inbox with a foreign Gmail threadId and a
    // stranger's address on a "Re:" (SEND-36). Fail it visibly instead.
    if (!enrollment.native_mailbox_id && enrollment.gmail_thread_id) {
      await markEnrollmentFailed(admin, enrollment.id, "Sending mailbox was deleted mid-sequence.");
      results.push({ enrollment_id: enrollment.id, result: "failed_mailbox_deleted" });
      continue;
    }
    let mailbox: NativeMailbox | undefined;
    if (enrollment.native_mailbox_id) {
      // Sticky: this enrollment already threads through one mailbox. If it's
      // ineligible this tick (paused, error, at cap, or not yet due per the
      // spacing gate), wait — never reroute mid-thread (breaks threading + SPF).
      mailbox = mailboxMap.get(enrollment.native_mailbox_id);
      if (!mailbox || !eligible(mailbox, campaign)) continue;
    } else {
      // Step 0: spread first-touches EVENLY — pick the eligible pool mailbox
      // that has sent fewest today (see `load`), so a new/smaller-cap inbox
      // warms instead of being starved by a warmed one. Filtered to inboxes
      // whose domain is still open to new leads (drain mode excludes
      // tired/resting domains; their in-flight threads continue above).
      const pool = (poolByCampaign.get(campaign.id) ?? [])
        .map((id) => mailboxMap.get(id))
        .filter((mb): mb is NativeMailbox => !!mb && eligible(mb, campaign) && domainOpenFor(mb));
      if (pool.length === 0) continue; // nothing available this tick
      pool.sort((a, b) => load(a) - load(b) || remaining(b) - remaining(a) || a.id.localeCompare(b.id));
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

    // ---- Gmail creds ready + every free gate passed → claim the step, then
    // hand off to the shared dispatch (verify → send → log → count). Then
    // advance the LINEAR position.
    const linearStep = enrollment.current_step_index;
    if (!(await claimStep(enrollment, linearStep))) {
      results.push({ enrollment_id: enrollment.id, result: "claimed_elsewhere" });
      continue;
    }
    const d = await dispatchEmail({
      campaign,
      enrollment,
      contact,
      mailbox,
      gmail,
      subject,
      bodyText,
      stepIndex: linearStep,
      inReplyTo: linearStep === 0 ? null : enrollment.last_rfc_message_id,
      references: linearStep === 0 ? null : enrollment.last_rfc_message_id,
    });
    if (d.status === "hold" || d.status === "retry" || d.status === "mailbox_auth") {
      await releaseStep(enrollment, linearStep);
      results.push({ enrollment_id: enrollment.id, result: d.resultTag });
      continue;
    }
    if (d.status === "skip" || d.status === "send_failed") {
      await markEnrollmentFailed(admin, enrollment.id, d.failReason);
      results.push({ enrollment_id: enrollment.id, result: d.resultTag });
      continue;
    }

    const nextIndex = linearStep + 1;
    const hasNext = steps?.has(nextIndex) ?? false;
    await writeAdvance(enrollment.id, {
      current_step_index: nextIndex,
      last_action_at: new Date().toISOString(),
      native_mailbox_id: mailbox.id,
      gmail_thread_id: d.threadId,
      last_rfc_message_id: d.rfcMessageId,
      last_error: null,
      status: hasNext ? "active" : "completed",
    });

    sent++;
    results.push({ enrollment_id: enrollment.id, result: hasNext ? "advanced" : "completed" });
  }

  // Persist per-org credit balance + error streak and enqueue edge-triggered
  // owner alerts (verifier down / credits low). Never throws. The returned
  // summary lands in the cron tally so a tick's verification activity
  // (armed/suppressed/tripped, calls, cached, held, skipped) is greppable.
  const verification = await finalizeVerifierStates(admin, verifierByOrg);

  return NextResponse.json({ status: "ok", sent, sideActions, deadline_hit: deadlineHit, verification, results });
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
  mailbox: NativeMailbox | null,
  spinKey?: string,
): string {
  // ORDERING IS LOAD-BEARING: resolve spintax BEFORE token substitution.
  // Token values come from operator-imported contact custom_fields (CSV data)
  // that may contain { | } characters; feeding those into the spintax parser
  // would corrupt the render. Spintax-first only ever parses author-written
  // template text, and a {{token}} chosen inside a spin branch still gets
  // filled by the token pass below.
  const source = spinKey ? renderSpintax(template, spinKey) : template;

  // No mailbox (a linkedin / internal node body) → blank sender identity; the
  // VA owns a linkedin task's copy anyway. Email sends always pass the mailbox.
  const senderName = mailbox
    ? mailbox.display_name?.trim() || mailbox.email_address.split("@")[0]
    : "";

  // buildTokenMap / applyTokens are the shared source of truth (also used by the
  // builder preview), keeping the send and the preview byte-identical.
  const map = buildTokenMap(contact, senderName);
  // Fail-safe: a LIVE email send (mailbox present) must NEVER emit a raw
  // {{token}} to a recipient — an unresolved variable with no inline |default
  // blanks instead of leaking braces. A VA-facing linkedin/internal task body
  // (no mailbox) keeps the {{token}} visible so the human can fill it in.
  const missing = mailbox ? () => "" : undefined;
  return applyTokens(source, map, missing).trim();
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
