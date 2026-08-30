// Daily heartbeat — proves the alert pipeline is alive.
//
// Sent every morning to every profile where role = 'owner'. The whole
// point is: if you stop seeing it, something is broken. The body is a
// small dashboard so a quick scan tells you whether yesterday went OK.
//
// What it monitors (in priority order):
//   1. Pending owner_alerts queue (should be ~0).
//   2. 24h send activity — reports + hot-leads.
//   3. Delivery confirmation gap — sends with sent_at stamped but
//      delivered_at still NULL after 30+ min. Strong proxy for
//      "RESEND_WEBHOOK_SECRET is wrong / webhook unregistered."
//   4. Stuck rows — orphan kpi_reports + lead_replies the retry cron
//      isn't picking up.
//   5. Schedule preview — what's due in the next 24h.
//   6. Config check — env presence + owner profile count.
//
// Robustness: each query is independent. A failure in one section
// shouldn't suppress the email — that would make the heartbeat itself
// unreliable, which is the failure mode we're trying to fix. Errors
// surface inline as "(query failed)" rather than throwing.

import type { createAdminClient } from "@/lib/supabase/admin";
import { isClientDueNow } from "@/lib/kpi/schedule";
import {
  effectiveDailyCap,
  rampStage,
  resolveDailyNewLeadsCap,
  resolveSendingStrategy,
  resolveSendWindow,
  minutesUntilWindowClose,
  startOfLocalDay,
  projectSequenceCompletion,
  type CompletionProjection,
} from "@/lib/gmail/ramp";
import type { Client, ReplyClass, HealthBand } from "@/types/app";
import { domainOf } from "@/lib/deliverability/check";

type AdminClient = ReturnType<typeof createAdminClient>;

export type HealthVerdict = "green" | "yellow" | "red";

export interface HeartbeatPayload {
  subject: string;
  html: string;
  verdict: HealthVerdict;
}

// Positive/"hot" reply classes — the unambiguous good-news outcomes, used for
// the morning summary's reply breakdown. (Which classes actually ping a client
// is governed per-client by clients.auto_notify_classes; this fixed set just
// keeps the headline "positive" count stable and channel-agnostic.)
const POSITIVE_REPLY_CLASSES: ReplyClass[] = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
];

// One active native-email campaign's morning line-item. All counts reconcile
// with the admin campaign detail page (same source columns + projection).
interface CampaignActivity {
  id: string;
  name: string;
  clientName: string | null;
  sentYesterday: number; // native_sends logged in the prior ET day
  scheduledToday: number; // remaining inbox capacity today, capped by active demand
  active: number;
  completed: number;
  replied: number;
  failed: number;
  enrolled: number;
  pctComplete: number; // (completed + replied) / enrolled, 0–100
  repliesYesterday: number;
  positiveRepliesYesterday: number;
  projection: CompletionProjection;
  waitingByStep: number[]; // active enrollments bucketed by current_step_index
  stepCount: number;
  warmingCount: number; // active pool mailboxes not yet fully warmed
}

interface CampaignTotals {
  activeCampaigns: number;
  pausedCampaigns: number;
  sentYesterday: number;
  scheduledToday: number;
  repliesYesterday: number;
  positiveRepliesYesterday: number;
}

interface CampaignSection {
  campaigns: CampaignActivity[];
  totals: CampaignTotals;
  error: string | null;
}

// One sending inbox's current health (denormalized on native_mailboxes by the
// hourly check-inbox-health cron).
interface InboxHealthRow {
  email: string;
  score: number | null; // null = never scored yet
  band: HealthBand | null;
  status: string; // native_mailboxes.status (active / paused / error)
  autoPaused: boolean; // health_paused_at set = auto-benched for health
}

// One sending domain's rollup (sending_domains, populated by the same hourly
// check-inbox-health cron — worst-member score + lifecycle state).
interface DomainHealthLine {
  domain: string;
  score: number | null;
  band: HealthBand | null;
  lifecycle: string; // sending_domains.lifecycle_status (active / warming / tired / …)
}

interface InboxHealthSection {
  total: number;
  healthy: number;
  watch: number;
  critical: number;
  autoPaused: number;
  unscored: number;
  freshestIso: string | null; // most recent health_checked_at across the pool
  stale: boolean; // freshest check > 3h old (or none) → check-inbox-health cron may be down
  mailboxes: InboxHealthRow[]; // all, worst-first
  domains: DomainHealthLine[]; // per sending domain, worst-first
  error: string | null;
}

interface HeartbeatSections {
  pendingAlerts: { count: number; oldest: string | null; error: string | null };
  recentActivity: {
    reportsSent24h: number;
    hotLeadsSent24h: number;
    error: string | null;
  };
  deliveryGap: {
    reportsAwaitingConfirmation: number; // sent_at set, delivered_at null, sent >30min ago
    hotLeadsAwaitingConfirmation: number;
    reportsBounced24h: number;
    hotLeadsBounced24h: number;
    error: string | null;
  };
  stuck: {
    orphanReports: number; // sent_at NULL && created_at < now-1h
    stalledHotLeadRetries: number; // failed && retry_count<5 && last_attempt < now-30min
    error: string | null;
  };
  upcoming: { dueIn24h: Array<{ name: string; whenIso: string }>; error: string | null };
  config: {
    resendKeySet: boolean;
    resendWebhookSecretSet: boolean;
    cronSecretSet: boolean;
    ownerCount: number;
    error: string | null;
  };
  campaignActivity: CampaignSection;
  inboxHealth: InboxHealthSection;
  sends14d: { days: number[]; total: number; error: string | null };
}

/**
 * Build the heartbeat email payload. Runs all checks in parallel.
 * Returns subject, HTML body, and an overall verdict the cron can log.
 */
export async function buildHeartbeat(
  admin: AdminClient,
  now: Date = new Date(),
): Promise<HeartbeatPayload> {
  const [
    pendingAlerts,
    recentActivity,
    deliveryGap,
    stuck,
    upcoming,
    config,
    campaignActivity,
    inboxHealth,
    sends14d,
  ] = await Promise.all([
    queryPendingAlerts(admin),
    queryRecentActivity(admin, now),
    queryDeliveryGap(admin, now),
    queryStuckRows(admin, now),
    queryUpcomingSchedule(admin, now),
    queryConfig(admin),
    queryCampaignActivity(admin, now),
    queryInboxHealth(admin, now),
    querySendSparkline(admin, now),
  ]);

  const sections: HeartbeatSections = {
    pendingAlerts,
    recentActivity,
    deliveryGap,
    stuck,
    upcoming,
    config,
    campaignActivity,
    inboxHealth,
    sends14d,
  };
  const verdict = computeVerdict(sections);
  const subject = buildSubject(sections, verdict, now);
  const html = buildHtml(sections, verdict, now);
  return { subject, html, verdict };
}

// ── Verdict ─────────────────────────────────────────────────────────────

function computeVerdict(s: HeartbeatSections): HealthVerdict {
  // Red: anything that means alerts are broken or delivery confidence is gone.
  if (!s.config.resendKeySet) return "red";
  if (!s.config.resendWebhookSecretSet) return "red";
  if (s.config.ownerCount === 0) return "red";
  if (s.pendingAlerts.count > 10) return "red";
  if (s.deliveryGap.reportsAwaitingConfirmation > 5) return "red";

  // Yellow: signals that need a glance but aren't actively breaking.
  if (s.pendingAlerts.count > 0) return "yellow";
  if (s.deliveryGap.reportsAwaitingConfirmation > 0) return "yellow";
  if (s.deliveryGap.hotLeadsAwaitingConfirmation > 0) return "yellow";
  if (s.stuck.orphanReports > 0) return "yellow";
  if (s.stuck.stalledHotLeadRetries > 0) return "yellow";
  if (s.deliveryGap.reportsBounced24h + s.deliveryGap.hotLeadsBounced24h > 0) return "yellow";
  if (s.inboxHealth.critical > 0) return "yellow";
  if (s.inboxHealth.watch > 0) return "yellow";
  if (s.inboxHealth.autoPaused > 0) return "yellow";
  if (s.inboxHealth.stale) return "yellow";

  return "green";
}

// ── Queries ─────────────────────────────────────────────────────────────

async function queryPendingAlerts(
  admin: AdminClient,
): Promise<HeartbeatSections["pendingAlerts"]> {
  const { data, error, count } = await admin
    .from("owner_alerts")
    .select("created_at", { count: "exact" })
    .is("sent_at", null)
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    return { count: 0, oldest: null, error: error.message };
  }
  const oldest =
    (data?.[0] as { created_at?: string } | undefined)?.created_at ?? null;
  return { count: count ?? 0, oldest, error: null };
}

async function queryRecentActivity(
  admin: AdminClient,
  now: Date,
): Promise<HeartbeatSections["recentActivity"]> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [reports, hotLeads] = await Promise.all([
    admin
      .from("kpi_reports")
      .select("id", { count: "exact", head: true })
      .gte("sent_at", since),
    admin
      .from("lead_replies")
      .select("id", { count: "exact", head: true })
      .gte("notified_at", since),
  ]);

  if (reports.error || hotLeads.error) {
    return {
      reportsSent24h: 0,
      hotLeadsSent24h: 0,
      error:
        reports.error?.message ?? hotLeads.error?.message ?? "(unknown error)",
    };
  }
  return {
    reportsSent24h: reports.count ?? 0,
    hotLeadsSent24h: hotLeads.count ?? 0,
    error: null,
  };
}

async function queryDeliveryGap(
  admin: AdminClient,
  now: Date,
): Promise<HeartbeatSections["deliveryGap"]> {
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  // Resend usually fires email.delivered within seconds. 30 min is generous —
  // if the field is still NULL after that, the webhook is silent.
  const sentBefore = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

  const [
    reportsAwaiting,
    hotLeadsAwaiting,
    reportsBounced,
    hotLeadsBounced,
  ] = await Promise.all([
    admin
      .from("kpi_reports")
      .select("id", { count: "exact", head: true })
      .gte("sent_at", since24h)
      .lt("sent_at", sentBefore)
      .is("delivered_at", null)
      .is("bounced_at", null),
    admin
      .from("lead_replies")
      .select("id", { count: "exact", head: true })
      .gte("notified_at", since24h)
      .lt("notified_at", sentBefore)
      .is("notification_delivered_at", null)
      .is("notification_bounced_at", null),
    admin
      .from("kpi_reports")
      .select("id", { count: "exact", head: true })
      .gte("bounced_at", since24h),
    admin
      .from("lead_replies")
      .select("id", { count: "exact", head: true })
      .gte("notification_bounced_at", since24h),
  ]);

  const firstError =
    reportsAwaiting.error ??
    hotLeadsAwaiting.error ??
    reportsBounced.error ??
    hotLeadsBounced.error;
  if (firstError) {
    return {
      reportsAwaitingConfirmation: 0,
      hotLeadsAwaitingConfirmation: 0,
      reportsBounced24h: 0,
      hotLeadsBounced24h: 0,
      error: firstError.message,
    };
  }

  return {
    reportsAwaitingConfirmation: reportsAwaiting.count ?? 0,
    hotLeadsAwaitingConfirmation: hotLeadsAwaiting.count ?? 0,
    reportsBounced24h: reportsBounced.count ?? 0,
    hotLeadsBounced24h: hotLeadsBounced.count ?? 0,
    error: null,
  };
}

async function queryStuckRows(
  admin: AdminClient,
  now: Date,
): Promise<HeartbeatSections["stuck"]> {
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

  const [orphans, stalledRetries] = await Promise.all([
    admin
      .from("kpi_reports")
      .select("id", { count: "exact", head: true })
      .is("sent_at", null)
      .lt("created_at", oneHourAgo),
    admin
      .from("lead_replies")
      .select("id", { count: "exact", head: true })
      .eq("notification_status", "failed")
      .lt("notification_retry_count", 5)
      .lt("notification_last_attempt_at", thirtyMinAgo),
  ]);

  if (orphans.error || stalledRetries.error) {
    return {
      orphanReports: 0,
      stalledHotLeadRetries: 0,
      error:
        orphans.error?.message ??
        stalledRetries.error?.message ??
        "(unknown error)",
    };
  }
  return {
    orphanReports: orphans.count ?? 0,
    stalledHotLeadRetries: stalledRetries.count ?? 0,
    error: null,
  };
}

async function queryUpcomingSchedule(
  admin: AdminClient,
  now: Date,
): Promise<HeartbeatSections["upcoming"]> {
  const { data, error } = await admin
    .from("clients")
    .select("*")
    .not("report_frequency", "is", null);

  if (error) {
    return { dueIn24h: [], error: error.message };
  }

  const clients = (data ?? []) as unknown as Client[];
  const dueIn24h: Array<{ name: string; whenIso: string }> = [];
  // Walk hour-by-hour over the next 24h and ask isClientDueNow at each slot.
  // The cron itself runs hourly so this is the same predicate that decides
  // whether an actual send fires. Cheap (≤24*N evaluations).
  for (let h = 1; h <= 24; h++) {
    const at = new Date(now.getTime() + h * 60 * 60 * 1000);
    for (const c of clients) {
      const check = isClientDueNow(c, at);
      if (check.isDue) {
        dueIn24h.push({ name: c.name, whenIso: at.toISOString() });
      }
    }
  }
  // Dedup (client could match in two adjacent hours if isClientDueNow rounds);
  // keep first occurrence.
  const seen = new Set<string>();
  const deduped = dueIn24h.filter((d) => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    return true;
  });
  return { dueIn24h: deduped, error: null };
}

async function queryConfig(
  admin: AdminClient,
): Promise<HeartbeatSections["config"]> {
  const { count, error } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "owner");

  return {
    resendKeySet: !!process.env.RESEND_API_KEY,
    resendWebhookSecretSet: !!process.env.RESEND_WEBHOOK_SECRET,
    cronSecretSet: !!process.env.CRON_SECRET,
    ownerCount: count ?? 0,
    error: error?.message ?? null,
  };
}

// Daily native-send counts for the last 14 ET days (oldest → newest, today
// last) — drives the morning brief's sparkline. Account-wide sending volume,
// not per-campaign; 14 count-only queries (no rows transferred). Fail-soft to
// an empty series so a hiccup here never blocks the heartbeat.
async function querySendSparkline(
  admin: AdminClient,
  now: Date,
): Promise<{ days: number[]; total: number; error: string | null }> {
  try {
    const starts: number[] = [];
    for (let i = 13; i >= 0; i--) {
      starts.push(startOfLocalDay(now.getTime() - i * 86_400_000));
    }
    const bounds = [...starts, startOfLocalDay(now.getTime()) + 86_400_000];
    const days = await Promise.all(
      starts.map(async (_, k) => {
        const { count } = await admin
          .from("native_sends")
          .select("id", { count: "exact", head: true })
          .gte("sent_at", new Date(bounds[k]).toISOString())
          .lt("sent_at", new Date(bounds[k + 1]).toISOString());
        return count ?? 0;
      }),
    );
    return { days, total: days.reduce((a, b) => a + b, 0), error: null };
  } catch (err) {
    return {
      days: [],
      total: 0,
      error: err instanceof Error ? err.message : "(unknown error)",
    };
  }
}

// Inbox health — reads the denormalized score the hourly check-inbox-health
// cron writes onto native_mailboxes (SPF/DKIM/DMARC/MX + Spamhaus DBL + 7-day
// bounce rate). Summarizes the pool by band, floats any non-healthy / paused /
// unscored inbox to the top, and flags staleness (a freshest check older than
// 3h means that cron has likely stopped — the whole point of surfacing this).
async function queryInboxHealth(
  admin: AdminClient,
  now: Date,
): Promise<InboxHealthSection> {
  const empty: InboxHealthSection = {
    total: 0,
    healthy: 0,
    watch: 0,
    critical: 0,
    autoPaused: 0,
    unscored: 0,
    freshestIso: null,
    stale: false,
    mailboxes: [],
    domains: [],
    error: null,
  };

  const { data, error } = await admin
    .from("native_mailboxes")
    .select(
      "email_address, status, health_score, health_band, health_checked_at, health_paused_at",
    );
  if (error) return { ...empty, error: error.message };

  const rows = (data ?? []) as {
    email_address: string;
    status: string;
    health_score: number | null;
    health_band: HealthBand | null;
    health_checked_at: string | null;
    health_paused_at: string | null;
  }[];

  const section: InboxHealthSection = { ...empty, total: rows.length };
  let freshest = 0;
  for (const r of rows) {
    if (r.health_band === "healthy") section.healthy++;
    else if (r.health_band === "watch") section.watch++;
    else if (r.health_band === "critical") section.critical++;
    if (r.health_score == null) section.unscored++;
    if (r.health_paused_at) section.autoPaused++;
    if (r.health_checked_at) {
      const t = Date.parse(r.health_checked_at);
      if (t > freshest) freshest = t;
    }
    section.mailboxes.push({
      email: r.email_address,
      score: r.health_score,
      band: r.health_band,
      status: r.status,
      autoPaused: !!r.health_paused_at,
    });
  }

  // Worst first: critical → auto-paused → watch → unscored → healthy; then by score.
  const rank = (m: InboxHealthRow): number =>
    m.band === "critical" ? 0 : m.autoPaused ? 1 : m.band === "watch" ? 2 : m.score == null ? 3 : 4;
  section.mailboxes.sort(
    (a, b) => rank(a) - rank(b) || (a.score ?? 101) - (b.score ?? 101),
  );

  section.freshestIso = freshest > 0 ? new Date(freshest).toISOString() : null;
  section.stale =
    rows.length > 0 && (freshest === 0 || now.getTime() - freshest > 3 * 60 * 60 * 1000);

  // Domain-level rollup (sending_domains, populated by the same cron). Read-only,
  // fail-soft: a read error just leaves domains empty — never fails the section.
  try {
    const liveDomains = new Set(rows.map((r) => domainOf(r.email_address)));
    const { data: dData, error: dErr } = await admin
      .from("sending_domains")
      .select("domain, health_score, health_band, lifecycle_status");
    if (!dErr && dData) {
      const dRank = (b: HealthBand | null): number =>
        b === "critical" ? 0 : b === "watch" ? 1 : b === "healthy" ? 2 : 3;
      section.domains = (
        dData as {
          domain: string;
          health_score: number | null;
          health_band: HealthBand | null;
          lifecycle_status: string;
        }[]
      )
        .filter((d) => liveDomains.has(d.domain))
        .map((d) => ({
          domain: d.domain,
          score: d.health_score,
          band: d.health_band,
          lifecycle: d.lifecycle_status,
        }))
        .sort((a, b) => dRank(a.band) - dRank(b.band) || (a.score ?? 101) - (b.score ?? 101));
    }
  } catch {
    // sending_domains may not exist yet in some environments — leave domains empty.
  }

  return section;
}

// Morning outreach snapshot — the operational half of the heartbeat: every
// active native-email campaign with yesterday's sends, today's scheduled
// capacity, reply outcomes, and its sequence/warmup position. Mirrors the
// admin campaign detail page's math (nativeStatsFor + projectSequenceCompletion)
// so the numbers reconcile. Wrapped in try/catch so a failure here degrades to
// an inline notice rather than suppressing the whole heartbeat.
type CampaignMeta = {
  id: string;
  name: string;
  client_id: string | null;
  status: string;
  send_timezone: string | null;
  send_start_hour: number | null;
  send_end_hour: number | null;
  send_weekdays_only: boolean | null;
  daily_new_leads_cap: number | null;
  sending_strategy: string | null;
};

async function queryCampaignActivity(
  admin: AdminClient,
  now: Date,
): Promise<CampaignSection> {
  const zero: CampaignTotals = {
    activeCampaigns: 0,
    pausedCampaigns: 0,
    sentYesterday: 0,
    scheduledToday: 0,
    repliesYesterday: 0,
    positiveRepliesYesterday: 0,
  };

  try {
    const { data: campRows, error: campErr } = await admin
      .from("campaigns")
      .select(
        "id, name, client_id, status, send_timezone, send_start_hour, send_end_hour, send_weekdays_only, daily_new_leads_cap, sending_strategy",
      )
      .eq("source_channel", "native_email")
      .eq("status", "active");
    if (campErr) return { campaigns: [], totals: zero, error: campErr.message };

    const active = (campRows ?? []) as CampaignMeta[];

    const { count: pausedCount } = await admin
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("source_channel", "native_email")
      .eq("status", "paused");

    if (active.length === 0) {
      return {
        campaigns: [],
        totals: { ...zero, pausedCampaigns: pausedCount ?? 0 },
        error: null,
      };
    }

    const ids = active.map((c) => c.id);
    // ET-day boundaries: yesterday = [start of yesterday, start of today).
    const todayStartIso = new Date(startOfLocalDay(now.getTime())).toISOString();
    const yStartIso = new Date(
      startOfLocalDay(now.getTime() - 86_400_000),
    ).toISOString();

    const clientIds = [
      ...new Set(active.map((c) => c.client_id).filter((v): v is string => !!v)),
    ];

    const [clientsRes, stepsRes, enrRes, sentYRes, repliesYRes, poolRes] =
      await Promise.all([
        clientIds.length
          ? admin.from("clients").select("id, name").in("id", clientIds)
          : Promise.resolve({ data: [] as { id: string; name: string }[] }),
        admin
          .from("campaign_steps")
          .select("campaign_id, step_index, wait_days")
          .in("campaign_id", ids)
          .order("step_index", { ascending: true }),
        admin
          .from("campaign_enrollments")
          .select("campaign_id, status, current_step_index")
          .in("campaign_id", ids),
        admin
          .from("native_sends")
          .select("campaign_id")
          .in("campaign_id", ids)
          .gte("sent_at", yStartIso)
          .lt("sent_at", todayStartIso),
        admin
          .from("lead_replies")
          .select("campaign_id, final_class")
          .in("campaign_id", ids)
          .eq("source_channel", "native_email")
          .gte("received_at", yStartIso)
          .lt("received_at", todayStartIso),
        admin
          .from("campaign_mailboxes")
          .select("campaign_id, mailbox_id")
          .in("campaign_id", ids),
      ]);

    const clientName = new Map<string, string>();
    for (const c of (clientsRes.data ?? []) as { id: string; name: string }[]) {
      clientName.set(c.id, c.name);
    }

    // Steps grouped per campaign (sorted by step_index for wait-day math).
    const stepsByCampaign = new Map<string, { wait_days: number }[]>();
    for (const s of (stepsRes.data ?? []) as {
      campaign_id: string;
      step_index: number;
      wait_days: number;
    }[]) {
      const arr = stepsByCampaign.get(s.campaign_id) ?? [];
      arr.push({ wait_days: s.wait_days });
      stepsByCampaign.set(s.campaign_id, arr);
    }

    // Enrollment status tallies + active-by-current-step buckets (the funnel).
    type Enr = {
      active: number;
      completed: number;
      replied: number;
      failed: number;
      waitingByStep: number[];
    };
    const enrByCampaign = new Map<string, Enr>();
    const ensureEnr = (cid: string): Enr => {
      let e = enrByCampaign.get(cid);
      if (!e) {
        const nSteps = (stepsByCampaign.get(cid) ?? []).length;
        e = {
          active: 0,
          completed: 0,
          replied: 0,
          failed: 0,
          waitingByStep: new Array(nSteps).fill(0),
        };
        enrByCampaign.set(cid, e);
      }
      return e;
    };
    for (const r of (enrRes.data ?? []) as {
      campaign_id: string;
      status: string;
      current_step_index: number | null;
    }[]) {
      const e = ensureEnr(r.campaign_id);
      if (r.status === "active") {
        e.active++;
        if (e.waitingByStep.length > 0) {
          const idx = Math.min(
            Math.max(r.current_step_index ?? 0, 0),
            e.waitingByStep.length - 1,
          );
          e.waitingByStep[idx]++;
        }
      } else if (r.status === "completed") e.completed++;
      else if (r.status === "replied") e.replied++;
      else if (r.status === "failed") e.failed++;
    }

    const sentYByCampaign = new Map<string, number>();
    for (const s of (sentYRes.data ?? []) as { campaign_id: string }[]) {
      sentYByCampaign.set(
        s.campaign_id,
        (sentYByCampaign.get(s.campaign_id) ?? 0) + 1,
      );
    }

    const repliesByCampaign = new Map<
      string,
      { total: number; positive: number }
    >();
    for (const r of (repliesYRes.data ?? []) as {
      campaign_id: string;
      final_class: ReplyClass | null;
    }[]) {
      const rec = repliesByCampaign.get(r.campaign_id) ?? {
        total: 0,
        positive: 0,
      };
      rec.total++;
      if (r.final_class && POSITIVE_REPLY_CLASSES.includes(r.final_class)) {
        rec.positive++;
      }
      repliesByCampaign.set(r.campaign_id, rec);
    }

    // Mailbox pools → capacity. Fetch each distinct mailbox once, then its
    // all-time send count (drives the warmup ramp cap) and today's count
    // (already-spent). Count-only queries — no rows transferred.
    const poolByCampaign = new Map<string, string[]>();
    const distinctMb = new Set<string>();
    for (const p of (poolRes.data ?? []) as {
      campaign_id: string;
      mailbox_id: string;
    }[]) {
      const arr = poolByCampaign.get(p.campaign_id) ?? [];
      arr.push(p.mailbox_id);
      poolByCampaign.set(p.campaign_id, arr);
      distinctMb.add(p.mailbox_id);
    }
    const mbMeta = new Map<
      string,
      { status: string; max_daily_cap: number; daily_cap_override: number | null }
    >();
    if (distinctMb.size > 0) {
      const { data: mbData } = await admin
        .from("native_mailboxes")
        .select("id, status, max_daily_cap, daily_cap_override")
        .in("id", [...distinctMb]);
      for (const m of (mbData ?? []) as {
        id: string;
        status: string;
        max_daily_cap: number;
        daily_cap_override: number | null;
      }[]) {
        mbMeta.set(m.id, {
          status: m.status,
          max_daily_cap: m.max_daily_cap,
          daily_cap_override: m.daily_cap_override,
        });
      }
    }
    const totalSent = new Map<string, number>();
    const sentToday = new Map<string, number>();
    await Promise.all(
      [...distinctMb].map(async (id) => {
        const [tot, tod] = await Promise.all([
          admin
            .from("native_sends")
            .select("id", { count: "exact", head: true })
            .eq("mailbox_id", id),
          admin
            .from("native_sends")
            .select("id", { count: "exact", head: true })
            .eq("mailbox_id", id)
            .gte("sent_at", todayStartIso),
        ]);
        totalSent.set(id, tot.count ?? 0);
        sentToday.set(id, tod.count ?? 0);
      }),
    );

    const campaigns: CampaignActivity[] = active.map((c) => {
      const steps = stepsByCampaign.get(c.id) ?? [];
      const e =
        enrByCampaign.get(c.id) ??
        ({
          active: 0,
          completed: 0,
          replied: 0,
          failed: 0,
          waitingByStep: new Array(steps.length).fill(0),
        } as Enr);
      const enrolled = e.active + e.completed + e.replied + e.failed;
      const pctComplete =
        enrolled > 0
          ? Math.round(((e.completed + e.replied) / enrolled) * 100)
          : 0;

      const window = resolveSendWindow(c);
      // Will this campaign send at all today? 0 on weekends (weekdaysOnly) or
      // once the window has closed — so a Saturday heartbeat honestly shows 0.
      const sendableToday = minutesUntilWindowClose(now, window) > 0;
      let capacity = 0; // remaining capacity today (drives scheduledToday)
      let fullCapacity = 0; // full daily cap sum — the reach_first first-touch rate
      let activeMbCount = 0;
      let warmingCount = 0;
      for (const mbId of poolByCampaign.get(c.id) ?? []) {
        const m = mbMeta.get(mbId);
        if (!m || m.status !== "active") continue;
        activeMbCount++;
        const tot = totalSent.get(mbId) ?? 0;
        if (!rampStage(tot).warmed) warmingCount++;
        const cap = effectiveDailyCap(
          { max_daily_cap: m.max_daily_cap, daily_cap_override: m.daily_cap_override },
          tot,
        );
        fullCapacity += cap;
        capacity += Math.max(0, cap - (sentToday.get(mbId) ?? 0));
      }
      // Can't send more than we have active contacts, nor more than inbox
      // capacity — the honest ceiling for the day.
      const scheduledToday = sendableToday
        ? Math.min(capacity, e.active)
        : 0;

      // Mirror the campaign detail page: reach_first drains first-touches at full
      // warmed inbox capacity, finish_first at the new-leads/day cap; 0 pauses.
      const strategy = resolveSendingStrategy(c);
      const newLeadsCap = resolveDailyNewLeadsCap(c);
      const projection = projectSequenceCompletion({
        firstTouchesRemaining: e.waitingByStep[0] ?? 0,
        firstTouchesPerDay: strategy === "reach_first" ? fullCapacity : newLeadsCap,
        newLeadsPaused: newLeadsCap <= 0,
        stepWaitDays: steps.map((s) => s.wait_days),
        waitingByStep: e.waitingByStep,
        weekdaysOnly: window.weekdaysOnly,
        strategy,
        mailboxCount: activeMbCount,
        now,
      });
      const reps = repliesByCampaign.get(c.id) ?? { total: 0, positive: 0 };

      return {
        id: c.id,
        name: c.name,
        clientName: c.client_id ? (clientName.get(c.client_id) ?? null) : null,
        sentYesterday: sentYByCampaign.get(c.id) ?? 0,
        scheduledToday,
        active: e.active,
        completed: e.completed,
        replied: e.replied,
        failed: e.failed,
        enrolled,
        pctComplete,
        repliesYesterday: reps.total,
        positiveRepliesYesterday: reps.positive,
        projection,
        waitingByStep: e.waitingByStep,
        stepCount: steps.length,
        warmingCount,
      };
    });

    // Busiest first (today + yesterday volume), then by active contact count.
    campaigns.sort(
      (a, b) =>
        b.scheduledToday +
        b.sentYesterday -
        (a.scheduledToday + a.sentYesterday) ||
        b.active - a.active,
    );

    const totals: CampaignTotals = {
      activeCampaigns: active.length,
      pausedCampaigns: pausedCount ?? 0,
      sentYesterday: campaigns.reduce((s, c) => s + c.sentYesterday, 0),
      scheduledToday: campaigns.reduce((s, c) => s + c.scheduledToday, 0),
      repliesYesterday: campaigns.reduce((s, c) => s + c.repliesYesterday, 0),
      positiveRepliesYesterday: campaigns.reduce(
        (s, c) => s + c.positiveRepliesYesterday,
        0,
      ),
    };

    return { campaigns, totals, error: null };
  } catch (err) {
    return {
      campaigns: [],
      totals: zero,
      error: err instanceof Error ? err.message : "(unknown error)",
    };
  }
}

// ── Rendering ───────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const VERDICT_LABEL: Record<HealthVerdict, string> = {
  green: "Healthy",
  yellow: "Needs a glance",
  red: "Action required",
};
const VERDICT_COLOR: Record<HealthVerdict, string> = {
  green: "#15803d",
  yellow: "#b45309",
  red: "#b91c1c",
};

function buildSubject(
  s: HeartbeatSections,
  verdict: HealthVerdict,
  now: Date,
): string {
  const t = s.campaignActivity.totals;
  const date = etShortDate(now);
  if (verdict === "green") {
    return `Good morning — ${t.sentYesterday} sent yesterday, ${t.scheduledToday} scheduled today (${date})`;
  }
  if (verdict === "yellow") {
    const n = countSignals(s);
    return `Good morning — ${t.sentYesterday} sent, ${t.scheduledToday} today · ${n} signal${n === 1 ? "" : "s"} to check (${date})`;
  }
  return `⚠ Action required — ${t.sentYesterday} sent, ${t.scheduledToday} scheduled today (${date})`;
}

function countSignals(s: HeartbeatSections): number {
  let n = 0;
  if (s.pendingAlerts.count > 0) n++;
  if (s.deliveryGap.reportsAwaitingConfirmation > 0) n++;
  if (s.deliveryGap.hotLeadsAwaitingConfirmation > 0) n++;
  if (s.stuck.orphanReports > 0) n++;
  if (s.stuck.stalledHotLeadRetries > 0) n++;
  if (s.deliveryGap.reportsBounced24h + s.deliveryGap.hotLeadsBounced24h > 0)
    n++;
  if (s.inboxHealth.critical > 0) n++;
  if (s.inboxHealth.watch > 0) n++;
  if (s.inboxHealth.autoPaused > 0) n++;
  if (s.inboxHealth.stale) n++;
  return n;
}

function check(value: boolean): string {
  return value
    ? `<span style="color:#15803d;">&#10003;</span>`
    : `<span style="color:#b91c1c;">&#10007;</span>`;
}

// Short ET date for the subject line, e.g. "Aug 6".
function etShortDate(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(now);
}

// Absolute admin dashboard URL. NEXT_PUBLIC_APP_URL already includes the /app
// basePath (see send-hot-lead.ts); fall back to prod so the button never breaks.
function dashboardUrl(): string {
  const base = (
    process.env.NEXT_PUBLIC_APP_URL || "https://leadstart-ebon.vercel.app/app"
  ).replace(/\/$/, "");
  return `${base}/admin`;
}

// One plain-English paragraph leading the email: yesterday's volume, today's
// plan, replies, and the health verdict.
function narrativeSummary(s: HeartbeatSections, verdict: HealthVerdict): string {
  const t = s.campaignActivity.totals;
  const health = healthPhrase(s, verdict);
  if (t.activeCampaigns === 0) {
    const paused =
      t.pausedCampaigns > 0
        ? ` ${t.pausedCampaigns} campaign${t.pausedCampaigns === 1 ? " is" : "s are"} paused.`
        : "";
    return `No native email campaigns are active right now.${paused} ${health}`;
  }
  const camps = `<b style="color:#2E37FE;">${t.activeCampaigns} active campaign${t.activeCampaigns === 1 ? "" : "s"}</b>`;
  const sentPhrase =
    t.sentYesterday > 0
      ? `Yesterday <b style="color:#2E37FE;">${t.sentYesterday.toLocaleString()} email${t.sentYesterday === 1 ? "" : "s"}</b> went out across ${camps}`
      : `No emails went out yesterday across ${camps}`;
  const schedPhrase =
    t.scheduledToday > 0
      ? `, and <b style="color:#1d4ed8;">${t.scheduledToday.toLocaleString()}</b> ${t.scheduledToday === 1 ? "is" : "are"} scheduled today`
      : `, and nothing is scheduled to send today`;
  const replyPhrase =
    t.repliesYesterday > 0
      ? ` You got <b style="color:#10b981;">${t.repliesYesterday} repl${t.repliesYesterday === 1 ? "y" : "ies"}</b>${t.positiveRepliesYesterday > 0 ? ` — <b style="color:#10b981;">${t.positiveRepliesYesterday} positive</b>` : ""}.`
      : ` No replies came in.`;
  return `${sentPhrase}${schedPhrase}.${replyPhrase} ${health}`;
}

function healthPhrase(s: HeartbeatSections, verdict: HealthVerdict): string {
  if (verdict === "green") return `Everything's <b style="color:#059669;">healthy</b>.`;
  if (verdict === "yellow") {
    const n = countSignals(s);
    return `<b style="color:#b45309;">${n} signal${n === 1 ? "" : "s"}</b> need${n === 1 ? "s" : ""} a glance below.`;
  }
  return `<b style="color:#b91c1c;">Action required</b> — see system checks below.`;
}

// One campaign card: progress bar, three stats (sent yesterday / scheduled
// today / replies), and the active-by-step waterfall.
function campaignCardHtml(c: CampaignActivity): string {
  const name = escapeHtml(c.name);
  const sub = c.clientName
    ? `<div style="font-size:11px;color:#9194AD;margin-top:1px;">${escapeHtml(c.clientName)}</div>`
    : "";
  const warming = c.warmingCount > 0;
  const chip = warming
    ? `<span style="font-size:10px;background:#fff7ed;color:#b45309;border-radius:4px;padding:2px 7px;font-weight:600;">warming</span>`
    : `<span style="font-size:10px;background:#ecfdf5;color:#059669;border-radius:4px;padding:2px 7px;font-weight:600;">active</span>`;
  const doneBy =
    c.projection.status === "projected" && c.projection.dateLabel
      ? `done by <b style="color:#3D3D5C;">${escapeHtml(c.projection.dateLabel)}</b>`
      : c.projection.status === "paused"
        ? `<span style="color:#b45309;">new leads paused</span>`
        : c.projection.status === "done"
          ? `<span style="color:#059669;">sequence complete</span>`
          : "";
  const barColor = warming
    ? "linear-gradient(90deg,#f59e0b,#b45309)"
    : "linear-gradient(90deg,#6B72FF,#2E37FE)";
  const pct = Math.max(2, Math.min(100, c.pctComplete));
  const totalActive = c.waitingByStep.reduce((a, b) => a + b, 0);
  const stageLine =
    c.stepCount > 1 && totalActive > 0
      ? `<div style="margin-top:12px;padding-top:10px;border-top:1px dashed #E2E3ED;font-size:11px;color:#6B6E8A;">Active by step: ${c.waitingByStep
          .map((n) => `<b style="color:#3D3D5C;">${n.toLocaleString()}</b>`)
          .join(' <span style="color:#c3c6d4;">&#8594;</span> ')} <span style="color:#9194AD;">(step 1&#8594;${c.stepCount})</span></div>`
      : "";
  const warmNote = warming
    ? ` · <span style="color:#b45309;">${c.warmingCount} inbox${c.warmingCount === 1 ? "" : "es"} warming</span>`
    : "";
  return `
  <div style="border:1px solid #E2E3ED;border-radius:12px;padding:16px;margin:0 0 12px;">
    <table width="100%" role="presentation"><tr>
      <td style="vertical-align:top;"><span style="font-size:15px;font-weight:700;color:#1A1A2E;">${name}</span> ${chip}${sub}</td>
      <td style="text-align:right;font-size:11.5px;color:#6B6E8A;vertical-align:top;white-space:nowrap;">${doneBy}</td>
    </tr></table>
    <div style="margin:10px 0 4px;background:#eef0f5;border-radius:6px;height:8px;overflow:hidden;"><div style="width:${pct}%;height:8px;background:${barColor};border-radius:6px;"></div></div>
    <p style="margin:0 0 12px;font-size:11px;color:#9194AD;">${c.pctComplete}% of the sequence complete · ${c.active.toLocaleString()} active contacts${warmNote}</p>
    ${stageLine}
  </div>`;
}

// Which inboxes/domains the health cron has flagged — a mailbox or domain on
// the watch or critical band, or an auto-benched mailbox. Everything else is
// healthy and stays hidden; the morning brief only surfaces what needs a look.
// Shared by the inbox card (renders the list) and the system-checks card
// (folds the all-clear count in when nothing is flagged).
function inboxAttention(h: InboxHealthSection): {
  mailboxes: InboxHealthRow[];
  domains: DomainHealthLine[];
  any: boolean;
  hasCritical: boolean;
} {
  const mailboxes = h.mailboxes.filter(
    (m) => m.band === "critical" || m.band === "watch" || m.autoPaused,
  );
  const domains = h.domains.filter(
    (d) => d.band === "critical" || d.band === "watch",
  );
  const hasCritical =
    mailboxes.some((m) => m.band === "critical" || m.autoPaused) ||
    domains.some((d) => d.band === "critical");
  return {
    mailboxes,
    domains,
    any: mailboxes.length + domains.length > 0,
    hasCritical,
  };
}

// Inbox health card — surfaced ONLY when the cron has flagged something (a
// mailbox/domain on watch or critical, or an auto-paused inbox). When every
// inbox is healthy this renders nothing and the all-clear count rides along in
// the system-checks card instead, keeping the quiet-morning brief short. Card
// tint is red when anything is critical/auto-paused, amber for watch-only.
function inboxHealthHtml(h: InboxHealthSection): string {
  if (h.error) {
    return `<div style="margin:0 0 12px;padding:10px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#b91c1c;font-size:12px;">Couldn't load inbox health: ${escapeHtml(h.error)}</div>`;
  }
  if (h.total === 0) return "";

  const attn = inboxAttention(h);
  if (!attn.any) return "";

  const bandColor = (b: HealthBand | null): string =>
    b === "critical" ? "#b91c1c" : b === "watch" ? "#b45309" : "#94a3b8";
  const bg = attn.hasCritical ? "#fef2f2" : "#fffbeb";
  const bd = attn.hasCritical ? "#fecaca" : "#fde68a";
  const titleColor = attn.hasCritical ? "#b91c1c" : "#b45309";
  const scoreOf = (s: number | null): string => (s == null ? "&#8212;" : String(s));

  // One flagged row: name (left) + band label & colored score (right).
  const line = (
    name: string,
    scoreTxt: string,
    color: string,
    label: string,
  ): string =>
    `<tr>
      <td style="padding:5px 0;font-size:12px;color:#3D3D5C;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:7px;"></span>${escapeHtml(name)}</td>
      <td style="padding:5px 0;text-align:right;white-space:nowrap;"><span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:${color};margin-right:8px;">${label}</span><span style="font-size:12.5px;font-weight:700;color:${color};">${scoreTxt}</span></td>
    </tr>`;
  const subhead = (t: string, mt: string): string =>
    `<div style="font-size:10px;font-weight:600;color:#9194AD;text-transform:uppercase;letter-spacing:0.03em;margin:${mt} 0 2px;">${t}</div>`;

  const domainRows = attn.domains.length
    ? subhead("Sending domains", "2px") +
      `<table width="100%" role="presentation">${attn.domains
        .map((d) =>
          line(
            d.lifecycle && d.lifecycle !== "active"
              ? `${d.domain} (${d.lifecycle})`
              : d.domain,
            scoreOf(d.score),
            bandColor(d.band),
            d.band ?? "",
          ),
        )
        .join("")}</table>`
    : "";
  const mailboxRows = attn.mailboxes.length
    ? subhead("Mailboxes", attn.domains.length ? "10px" : "2px") +
      `<table width="100%" role="presentation">${attn.mailboxes
        .map((m) =>
          line(
            m.email,
            scoreOf(m.score),
            m.autoPaused ? "#b91c1c" : bandColor(m.band),
            m.autoPaused ? "paused" : (m.band ?? ""),
          ),
        )
        .join("")}</table>`
    : "";

  return `
  <div style="background:${bg};border:1px solid ${bd};border-radius:12px;padding:16px;margin:0 0 12px;">
    <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:${titleColor};">&#9888; Inboxes needing attention</p>
    <p style="margin:0 0 8px;font-size:11px;color:#6B6E8A;">Flagged watch or critical by the health check &#8212; everything else is healthy.</p>
    ${domainRows}
    ${mailboxRows}
  </div>`;
}

// The health beacon, folded into one card: a compact all-clear grid when green,
// or a specific problem list (amber/red) when something needs action. The
// footnote always carries pipeline throughput + what reports are due.
function systemChecksHtml(s: HeartbeatSections, verdict: HealthVerdict): string {
  const dg = s.deliveryGap;
  const bounced = dg.reportsBounced24h + dg.hotLeadsBounced24h;

  const problems: string[] = [];
  if (!s.config.resendKeySet) problems.push("RESEND_API_KEY is missing");
  if (!s.config.resendWebhookSecretSet)
    problems.push("RESEND_WEBHOOK_SECRET is missing — delivery can't be confirmed");
  if (s.config.ownerCount === 0) problems.push("no owner profiles configured");
  if (s.pendingAlerts.count > 0)
    problems.push(`${s.pendingAlerts.count} alert${s.pendingAlerts.count === 1 ? "" : "s"} pending in the queue`);
  if (dg.reportsAwaitingConfirmation > 0)
    problems.push(`${dg.reportsAwaitingConfirmation} report${dg.reportsAwaitingConfirmation === 1 ? "" : "s"} awaiting delivery confirmation`);
  if (dg.hotLeadsAwaitingConfirmation > 0)
    problems.push(`${dg.hotLeadsAwaitingConfirmation} hot-lead notification${dg.hotLeadsAwaitingConfirmation === 1 ? "" : "s"} awaiting confirmation`);
  if (bounced > 0)
    problems.push(`${bounced} bounce${bounced === 1 ? "" : "s"} in the last 24h`);
  if (s.stuck.orphanReports > 0)
    problems.push(`${s.stuck.orphanReports} report${s.stuck.orphanReports === 1 ? "" : "s"} created but never sent`);
  if (s.stuck.stalledHotLeadRetries > 0)
    problems.push(`${s.stuck.stalledHotLeadRetries} hot-lead retr${s.stuck.stalledHotLeadRetries === 1 ? "y" : "ies"} stalled`);
  if (s.inboxHealth.critical > 0)
    problems.push(`${s.inboxHealth.critical} sending inbox${s.inboxHealth.critical === 1 ? "" : "es"} scored critical health`);
  if (s.inboxHealth.watch > 0)
    problems.push(`${s.inboxHealth.watch} sending inbox${s.inboxHealth.watch === 1 ? "" : "es"} flagged watch`);
  if (s.inboxHealth.autoPaused > 0)
    problems.push(`${s.inboxHealth.autoPaused} inbox${s.inboxHealth.autoPaused === 1 ? "" : "es"} auto-paused for health`);
  if (s.inboxHealth.stale)
    problems.push(`inbox health checks are stale — the check-inbox-health cron may be down`);
  const queryErr =
    s.pendingAlerts.error ||
    s.recentActivity.error ||
    s.deliveryGap.error ||
    s.stuck.error ||
    s.config.error ||
    s.inboxHealth.error;
  if (queryErr) problems.push(`a health query failed: ${queryErr}`);

  const dueNames = s.upcoming.dueIn24h.map((d) => escapeHtml(d.name));
  const footNote = `${s.recentActivity.reportsSent24h} report${s.recentActivity.reportsSent24h === 1 ? "" : "s"} &amp; ${s.recentActivity.hotLeadsSent24h} hot-lead notification${s.recentActivity.hotLeadsSent24h === 1 ? "" : "s"} sent in 24h · ${dueNames.length ? `reports due next 24h: ${dueNames.join(", ")}` : "no reports due next 24h"}`;

  if (verdict === "green" && problems.length === 0) {
    const cell = (ok: string) =>
      `<td style="padding:3px 0;font-size:11.5px;color:#047857;">&#10003; ${ok}</td>`;
    return `
    <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:16px;">
      <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#065f46;">&#10003; System checks — all clear</p>
      <table width="100%" role="presentation">
        <tr>${cell("0 pending alerts")}${cell("Delivery confirmed (webhook live)")}</tr>
        <tr>${cell("0 bounces in 24h")}${cell("0 stuck rows")}</tr>
        <tr>${cell("Env &amp; keys OK")}${cell(`${s.config.ownerCount} owner profile${s.config.ownerCount === 1 ? "" : "s"}`)}</tr>
        ${s.inboxHealth.total > 0 ? `<tr>${cell(`${s.inboxHealth.healthy} inbox${s.inboxHealth.healthy === 1 ? "" : "es"} healthy`)}<td></td></tr>` : ""}
      </table>
      <p style="margin:10px 0 0;font-size:11px;color:#059669;border-top:1px solid #a7f3d0;padding-top:8px;">${footNote}</p>
    </div>`;
  }

  const color = VERDICT_COLOR[verdict];
  const bg = verdict === "red" ? "#fef2f2" : "#fffbeb";
  const bd = verdict === "red" ? "#fecaca" : "#fde68a";
  const items = problems
    .map((p) => `<li style="margin:0 0 4px;">${escapeHtml(p)}</li>`)
    .join("");
  return `
  <div style="background:${bg};border:1px solid ${bd};border-radius:12px;padding:16px;">
    <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:${color};">&#9888; ${escapeHtml(VERDICT_LABEL[verdict])} — ${problems.length} thing${problems.length === 1 ? "" : "s"} to look at</p>
    <ul style="margin:0;padding-left:18px;font-size:12.5px;color:${color};line-height:1.5;">${items}</ul>
    <p style="margin:10px 0 0;font-size:11px;color:#6B6E8A;border-top:1px solid ${bd};padding-top:8px;">${footNote}</p>
  </div>`;
}

// The three headline totals as color-coded stat cards — mirrors the admin
// dashboard's KPI tiles. Two-line labels (metric + timeframe) so "scheduled
// today" and "replies yesterday" read unambiguously. Table-based for email.
function kpiRowHtml(t: CampaignTotals): string {
  const cell = (
    n: number,
    label: string,
    when: string,
    color: string,
    bg: string,
    bd: string,
  ): string =>
    `<td width="33%" style="padding:0 4px;vertical-align:top;">
      <div style="background:${bg};border:1px solid ${bd};border-radius:12px;padding:14px 6px 12px;text-align:center;">
        <div style="font-size:26px;font-weight:800;line-height:1;color:${color};">${n.toLocaleString()}</div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:#475569;margin-top:8px;">${label}</div>
        <div style="font-size:9px;color:#94a3b8;margin-top:1px;">${when}</div>
      </div>
    </td>`;
  return `<table width="100%" role="presentation" style="margin:0 0 14px;"><tr>
      ${cell(t.sentYesterday, "Sent", "yesterday", "#0f172a", "#f1f5f9", "#e2e8f0")}
      ${cell(t.scheduledToday, "Scheduled", "today", "#2E37FE", "#EDEEFF", "#D1D3FF")}
      ${cell(t.repliesYesterday, "Replies", "yesterday", "#059669", "#ecfdf5", "#a7f3d0")}
    </tr></table>`;
}

// Email-safe 14-day daily-sends sparkline — a row of table-cell bars (inline
// SVG is dropped by most mail clients). Bars scale to the busiest day; zero
// days show a faint baseline, today's bar is the deeper brand blue. Fail-soft:
// an errored or empty series renders nothing.
function sparklineHtml(sp: {
  days: number[];
  total: number;
  error: string | null;
}): string {
  if (sp.error || sp.days.length === 0) return "";
  const max = Math.max(...sp.days, 1);
  const MAX_H = 38;
  const bars = sp.days
    .map((n, i) => {
      const isToday = i === sp.days.length - 1;
      const h = n > 0 ? Math.max(3, Math.round((n / max) * MAX_H)) : 2;
      const color = n > 0 ? (isToday ? "#1C24B8" : "#2E37FE") : "#e2e8f0";
      return `<td style="height:${MAX_H}px;vertical-align:bottom;padding:0 1.5px;"><div style="height:${h}px;background:${color};border-radius:2px 2px 0 0;font-size:0;line-height:0;">&#8203;</div></td>`;
    })
    .join("");
  const rightLabel =
    sp.total > 0
      ? `${sp.total.toLocaleString()} sent`
      : "no sends yet";
  return `
  <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px 10px;margin:0 0 14px;">
    <table width="100%" role="presentation"><tr>
      <td style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#64748b;">Daily sends &#183; 14d</td>
      <td style="text-align:right;font-size:10px;font-weight:600;color:#94a3b8;">${rightLabel}</td>
    </tr></table>
    <table width="100%" role="presentation" style="table-layout:fixed;border-collapse:collapse;margin-top:9px;border-bottom:1px solid #eef2f7;"><tr>${bars}</tr></table>
  </div>`;
}

function buildHtml(
  s: HeartbeatSections,
  verdict: HealthVerdict,
  now: Date,
): string {
  const ca = s.campaignActivity;
  const eyebrow = `Daily brief · ${etShortDate(now)}`;
  const summary = narrativeSummary(s, verdict);

  const campErr = ca.error
    ? `<div style="margin:0 0 12px;padding:10px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#b91c1c;font-size:12px;">Couldn't load campaign activity: ${escapeHtml(ca.error)}</div>`
    : "";

  const MAX_CARDS = 8;
  const cardsHtml = ca.campaigns.length
    ? ca.campaigns.slice(0, MAX_CARDS).map(campaignCardHtml).join("") +
      (ca.campaigns.length > MAX_CARDS
        ? `<p style="margin:0 0 12px;font-size:11.5px;color:#9194AD;text-align:center;">+ ${ca.campaigns.length - MAX_CARDS} more active campaign${ca.campaigns.length - MAX_CARDS === 1 ? "" : "s"} — see the dashboard.</p>`
        : "")
    : `<div style="border:1px dashed #E2E3ED;border-radius:12px;padding:20px;text-align:center;color:#6B6E8A;font-size:13px;margin:0 0 12px;">No active native email campaigns right now.</div>`;

  return `
<div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E2E3ED;max-width:600px;color:#1A1A2E;">
  <div style="background:linear-gradient(135deg,#6B72FF 0%,#2E37FE 30%,#1C24B8 65%,#0F1880 100%);padding:26px 28px;">
    <p style="margin:0;color:rgba(255,255,255,0.7);font-size:12px;text-transform:uppercase;letter-spacing:1px;">${escapeHtml(eyebrow)}</p>
    <h1 style="margin:5px 0 0;color:#ffffff;font-size:23px;font-weight:700;letter-spacing:-0.4px;">Good morning</h1>
  </div>
  <div style="padding:20px 22px 4px;">
    ${ca.totals.activeCampaigns > 0 ? kpiRowHtml(ca.totals) : ""}
    ${ca.totals.activeCampaigns > 0 ? sparklineHtml(s.sends14d) : ""}
    <p style="margin:0;font-size:15px;line-height:1.6;color:#3D3D5C;">${summary}</p>
  </div>
  <div style="padding:12px 22px 4px;">
    ${campErr}
    ${cardsHtml}
  </div>
  <div style="padding:0 22px 4px;">
    ${inboxHealthHtml(s.inboxHealth)}
  </div>
  <div style="padding:14px 22px 8px;">
    ${systemChecksHtml(s, verdict)}
  </div>
  <div style="padding:8px 22px 26px;text-align:center;">
    <a href="${dashboardUrl()}" style="display:inline-block;background:linear-gradient(135deg,#6B72FF,#2E37FE);color:#ffffff;text-decoration:none;padding:13px 30px;border-radius:10px;font-size:14px;font-weight:600;">Open your dashboard &#8594;</a>
    <p style="margin:14px 0 0;font-size:11px;color:#9194AD;">Sent every morning by LeadStart. If this email stops arriving, the alert pipeline itself is down — check the <code>owner-heartbeat</code> cron logs.</p>
  </div>
</div>`.trim();
}
