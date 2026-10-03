// The finish date for a native campaign that is already sending: the Campaign
// Planner's dispatcher replay (engine.ts simulateCampaign) started from where
// the campaign is right now instead of from a fresh list. The campaign page's
// "Projected sequence completion" banner and the morning heartbeat both read
// it, so they always agree. src/lib/campaigns/live-send-state.ts does the
// database reads and hands over a LiveSnapshot; everything after that (time
// zones, the ramp baseline, sticky inboxes, the replay, the wording) is pure
// and lives here, where scripts/test-planner-math.ts can check it.

import { domainOpenForNewLeads } from "@/lib/deliverability/lifecycle";
import {
  ABSOLUTE_MAX_DAILY_CAP,
  SEND_WINDOW,
  effectiveDailyCap,
  rampStage,
  resolveDailyNewLeadsCap,
  resolveSendWindow,
  resolveSendingStrategy,
  type SendWindowConfig,
} from "@/lib/gmail/ramp";
import { formatCivilDate, formatInt } from "@/lib/format";
import type { DomainLifecycle, SendingStrategy } from "@/types/app";
import { daysBetween, type CivilDate } from "./dates";
import {
  SIM_HORIZON_DAYS,
  simulateCampaign,
  type CampaignSimInput,
  type FollowupPrefilter,
  type LiveInbox,
  type LiveRow,
  type SimResult,
} from "./engine";

export interface CompletionProjection {
  // projected : a date is available
  // paused    : first emails are queued but the new-leads cap is 0
  // done      : nothing is left to send
  // unknown   : no steps, no inbox that can send, or no finish in sight
  status: "projected" | "paused" | "done" | "unknown";
  dateLabel: string | null; // e.g. "Nov 18, 2026"
  sendingDays: number | null; // send days from today through the last email
  weeks: number | null; // calendar weeks from today to the last email (at least 1)
  driver: string; // plain sentences on what sets the date
}

/** One campaign's live state as live-send-state.ts reads it: raw rows, no math. */
export interface LiveSnapshot {
  /** When the reads were taken (ISO). */
  now: string;
  campaign: {
    daily_new_leads_cap: number | null;
    sending_strategy: string | null;
    send_timezone: string | null;
    send_start_hour: number | null;
    send_end_hour: number | null;
    send_weekdays_only: boolean | null;
    flow_graph: unknown;
  };
  /** campaign_steps.wait_days in step_index order. */
  waits: number[];
  /** campaign_mailboxes: the campaign's pool. */
  poolIds: string[];
  /** The pool's inboxes plus any inbox an active contact is stuck to. */
  mailboxes: {
    id: string;
    status: string;
    max_daily_cap: number;
    daily_cap_override: number | null;
    ramp_baseline_sent: number | null;
    domain_id: string | null;
    /** native_sends from this inbox, all time, every campaign. */
    total_sent: number;
  }[];
  /** native_sends from those inboxes since ET midnight (the dispatcher's day), every campaign. */
  sendsToday: { mailbox_id: string; sent_at: string }[];
  /** This campaign's first emails (step 0) since ET midnight. */
  newLeadsToday: number;
  /** The campaign's ACTIVE enrollments. */
  enrollments: {
    current_step_index: number | null;
    last_action_at: string | null;
    started_at: string | null;
    native_mailbox_id: string | null;
    gmail_thread_id: string | null;
  }[];
  /** sending_domains of those inboxes; sent_today is the domain's sends today when it has a cap. */
  domains: { id: string; lifecycle_status: string; max_daily_sends: number | null; sent_today: number }[];
  /** Other campaigns' emails per send day, which share the dispatcher's per-tick budget. */
  otherSendsPerDay: number;
}

/** Today's civil date and minutes after local midnight in `timeZone`, plus that midnight in epoch ms. */
export function localClock(now: Date, timeZone: string): { date: CivilDate; minute: number; midnightMs: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const hour = Number(get("hour")) % 24; // Intl can render midnight as "24"
  const msOfDay = ((hour * 60 + Number(get("minute"))) * 60 + Number(get("second"))) * 1000 + now.getUTCMilliseconds();
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minute: msOfDay / 60_000, midnightMs: now.getTime() - msOfDay };
}

/**
 * How route.ts narrows this campaign's follow-up fetch: a flow graph filters
 * by the smallest wait on its top-level nodes (none when its waits sit inside a
 * condition), a linear campaign by each row's own step.
 */
export function followupPrefilter(flowGraph: unknown): { prefilter: FollowupPrefilter; waitDays: number | null } {
  const g = flowGraph as { nodes?: unknown } | null;
  if (g && typeof g === "object" && Array.isArray(g.nodes) && g.nodes.length > 0) {
    let minWait = Infinity;
    for (const n of g.nodes as ({ wait_days?: unknown } | null)[]) {
      const w = n?.wait_days;
      if (typeof w === "number" && w >= 0) minWait = Math.min(minWait, w);
    }
    return Number.isFinite(minWait) && minWait > 0
      ? { prefilter: "min_wait", waitDays: minWait }
      : { prefilter: "none", waitDays: null };
  }
  return { prefilter: "exact", waitDays: null };
}

export interface LivePoolInbox {
  id: string;
  active: boolean;
  /** Today's cap: the ramp read at the start of the day, as the dispatcher pins it. */
  capToday: number;
  /** The cap once warm (its max_daily_cap or override, never above 20). */
  capWarm: number;
  sentToday: number;
  /** Past the last warmup stage, counting from ramp_baseline_sent. */
  warmed: boolean;
}

export interface LiveModel {
  input: CampaignSimInput;
  window: SendWindowConfig;
  strategy: SendingStrategy;
  newLeadsCap: number;
  today: CivilDate;
  /** Active contacts not emailed yet. */
  firstTouches: number;
  /** Active contacts in the follow-up queue that are still owed an email. */
  inFlight: number;
  /** Mid-thread contacts whose inbox was deleted: the dispatcher fails them, so they never send. */
  orphaned: number;
  pool: LivePoolInbox[];
}

/** The engine's view of a live campaign, from the rows the dispatcher reads. */
export function buildLiveModel(snap: LiveSnapshot): LiveModel {
  const window = safeWindow(resolveSendWindow(snap.campaign));
  const strategy = resolveSendingStrategy(snap.campaign);
  const newLeadsCap = resolveDailyNewLeadsCap(snap.campaign);
  const waits = snap.waits.map((w) => Math.max(0, Number(w) || 0));
  const clock = localClock(new Date(snap.now), window.timezone);
  const minuteOf = (iso: string) => (Date.parse(iso) - clock.midnightMs) / 60_000;

  // Today's sends per inbox: the count against the day's cap and the last send
  // for the spacing gate (route.ts sentToday / lastSentTodayMs).
  const today = new Map<string, { n: number; lastMs: number }>();
  for (const s of snap.sendsToday) {
    const t = Date.parse(s.sent_at);
    const cur = today.get(s.mailbox_id) ?? { n: 0, lastMs: -Infinity };
    cur.n++;
    if (t > cur.lastMs) cur.lastMs = t;
    today.set(s.mailbox_id, cur);
  }

  // Domains: open to new leads per lifecycle (unknown = open, as in route.ts),
  // and an index for each one with a daily cap.
  const domainById = new Map(snap.domains.map((d) => [d.id, d]));
  const cappedDomains: { cap: number | null; sentToday: number }[] = [];
  const cappedIndex = new Map<string, number>();
  for (const d of snap.domains) {
    if (d.max_daily_sends == null) continue;
    cappedIndex.set(d.id, cappedDomains.length);
    cappedDomains.push({ cap: d.max_daily_sends, sentToday: d.sent_today });
  }

  // Inboxes in route.ts's tie-break order (id), so "lowest index" = lowest id.
  const pool = new Set(snap.poolIds);
  const mbs = [...snap.mailboxes].sort((a, b) => a.id.localeCompare(b.id));
  const indexOf = new Map(mbs.map((m, i) => [m.id, i]));
  const inboxes: LiveInbox[] = [];
  const poolView: LivePoolInbox[] = [];
  for (const m of mbs) {
    const t = today.get(m.id);
    const sentToday = t?.n ?? 0;
    const rampSent = Math.max(0, m.total_sent - (m.ramp_baseline_sent ?? 0));
    const rampSentAtDayStart = Math.max(0, rampSent - sentToday);
    const domain = m.domain_id ? domainById.get(m.domain_id) : undefined;
    const open = !domain || domainOpenForNewLeads(domain.lifecycle_status as DomainLifecycle);
    const active = m.status === "active";
    inboxes.push({
      rampSentAtDayStart,
      sentToday,
      lastSendMinute: t ? (t.lastMs - clock.midnightMs) / 60_000 : null,
      maxDailyCap: m.max_daily_cap,
      dailyCapOverride: m.daily_cap_override,
      active,
      takesNewLeads: pool.has(m.id) && open,
      domain: m.domain_id != null ? (cappedIndex.get(m.domain_id) ?? null) : null,
    });
    if (pool.has(m.id)) {
      poolView.push({
        id: m.id,
        active,
        capToday: effectiveDailyCap(m, rampSentAtDayStart),
        capWarm: effectiveDailyCap(m, Number.MAX_SAFE_INTEGER),
        sentToday,
        warmed: rampStage(rampSent).warmed,
      });
    }
  }

  // Enrollments: never-actioned rows wait in the new-lead queue (started_at
  // order, due after the first email's wait); the rest are the follow-up queue,
  // each on its sticky inbox.
  const firstDue: number[] = [];
  const rows: LiveRow[] = [];
  let orphaned = 0;
  let missing = false;
  for (const e of snap.enrollments) {
    if (e.last_action_at == null) {
      firstDue.push(e.started_at ? minuteOf(e.started_at) + (waits[0] ?? 0) * 1440 : clock.minute);
      continue;
    }
    if (!e.native_mailbox_id && e.gmail_thread_id) {
      orphaned++; // route.ts fails these ("Sending mailbox was deleted mid-sequence")
      continue;
    }
    let inbox = -1; // no sticky inbox yet: the dispatcher picks from the pool
    if (e.native_mailbox_id) {
      // A sticky inbox missing from the read stands in as one that can't send,
      // so its contacts count as stuck instead of moving to another inbox.
      inbox = indexOf.get(e.native_mailbox_id) ?? inboxes.length;
      if (inbox === inboxes.length) missing = true;
    }
    rows.push({ step: e.current_step_index ?? 0, lastActionMinute: minuteOf(e.last_action_at), inbox });
  }
  if (missing) inboxes.push(MISSING_INBOX);
  const emails = Math.max(1, waits.length);

  const { prefilter, waitDays } = followupPrefilter(snap.campaign.flow_graph);
  const input: CampaignSimInput = {
    contacts: firstDue.length,
    waits: waits.length > 0 ? waits : [0],
    // Plan-only fields: a live replay takes its inboxes from `live`.
    domains: 1,
    inboxesPerDomain: 1,
    maxDailyCap: ABSOLUTE_MAX_DAILY_CAP,
    strategy,
    newLeadsCap,
    weekdaysOnly: window.weekdaysOnly,
    startHour: window.startHour,
    endHour: window.endHour,
    domainDailyCap: null,
    otherSendsPerDay: Math.max(0, snap.otherSendsPerDay),
    startWarmed: false,
    launchDate: clock.date,
    prefilter,
    prefilterWaitDays: waitDays ?? undefined,
    live: {
      inboxes,
      rows,
      nowMinute: clock.minute,
      newLeadsToday: snap.newLeadsToday,
      firstTouchDueMinutes: firstDue,
      domains: cappedDomains,
    },
  };

  return {
    input,
    window,
    strategy,
    newLeadsCap,
    today: clock.date,
    firstTouches: firstDue.length,
    inFlight: rows.filter((r) => r.step < emails).length,
    orphaned,
    pool: poolView,
  };
}

const MISSING_INBOX: LiveInbox = {
  rampSentAtDayStart: 0,
  sentToday: 0,
  lastSendMinute: null,
  maxDailyCap: 0,
  dailyCapOverride: null,
  active: false,
  takesNewLeads: false,
  domain: null,
};

// A window whose timezone Intl can't read would throw on every page load; fall
// back to the default zone (the dispatcher would fail the same way, loudly).
function safeWindow(w: SendWindowConfig): SendWindowConfig {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: w.timezone });
    return w;
  } catch {
    return { ...w, timezone: SEND_WINDOW.timezone };
  }
}

export interface LiveCapacity {
  /** Active inboxes in the pool. */
  activeInboxes: number;
  /** Their combined cap today. */
  capacityToday: number;
  /** What's left of it today. */
  remainingToday: number;
  /** Active pool inboxes still on the warmup ramp. */
  warmingInboxes: number;
}

export function liveCapacity(model: LiveModel): LiveCapacity {
  const active = model.pool.filter((p) => p.active);
  return {
    activeInboxes: active.length,
    capacityToday: active.reduce((s, p) => s + p.capToday, 0),
    remainingToday: active.reduce((s, p) => s + Math.max(0, p.capToday - p.sentToday), 0),
    warmingInboxes: active.filter((p) => !p.warmed).length,
  };
}

export interface LiveProjection {
  projection: CompletionProjection;
  model: LiveModel;
  sim: SimResult | null;
}

const plural = (n: number, one: string, many: string) => `${formatInt(n)} ${n === 1 ? one : many}`;

/** The engine-backed finish date for a running campaign, in the banner's shape. */
export function projectLiveCampaign(snap: LiveSnapshot): LiveProjection {
  const model = buildLiveModel(snap);
  const result = (projection: CompletionProjection, sim: SimResult | null = null): LiveProjection => ({
    projection,
    model,
    sim,
  });
  const none = { dateLabel: null, sendingDays: null, weeks: null };

  if (snap.waits.length === 0) {
    return result({ status: "unknown", ...none, driver: "No sequence steps configured yet." });
  }
  if (snap.enrollments.length === 0) {
    return result({
      status: "done",
      ...none,
      driver: "No active contacts remaining: every enrolled contact has finished, replied, or exited.",
    });
  }
  if (model.firstTouches > 0 && model.newLeadsCap <= 0) {
    return result({
      status: "paused",
      ...none,
      driver: `${plural(model.firstTouches, "first email is", "first emails are")} queued, but new leads are paused (0/day). Resume them to project a finish date.`,
    });
  }

  const sim = simulateCampaign(model.input);
  const stuck = sim.stuckRows;
  const leftOut: string[] = [];
  if (stuck > 0) leftOut.push(`${plural(stuck, "contact waits", "contacts wait")} on a paused or errored inbox and ${stuck === 1 ? "is" : "are"} left out.`);
  if (model.orphaned > 0) leftOut.push(`${plural(model.orphaned, "contact", "contacts")} lost ${model.orphaned === 1 ? "its" : "their"} inbox mid-sequence and will fail.`);

  if (sim.status !== "projected") {
    // A replay that ran out of days (rather than refusing to start) never finishes at this pace.
    const reason =
      sim.days.length > 0
        ? `No finish within ${Math.round(SIM_HORIZON_DAYS / 365)} years at this pace. Add inboxes, raise the new-leads cap, or shorten the sequence.`
        : (sim.reason ?? "No finish date at this setup.");
    return result({ status: "unknown", ...none, driver: [reason, ...leftOut].join(" ") }, sim);
  }
  if (sim.lastSendDate == null) {
    return result(
      stuck > 0
        ? {
            status: "unknown",
            ...none,
            driver: [
              `Nothing else can send: ${plural(stuck, "contact waits", "contacts wait")} on a paused or errored inbox. Resume it to project a finish date.`,
              ...leftOut.slice(1),
            ].join(" "),
          }
        : {
            status: "done",
            ...none,
            driver:
              model.orphaned > 0
                ? `Nothing left to send. ${leftOut.join(" ")}`
                : "Every active contact has had their last email; they close out on the next send tick.",
          },
      sim,
    );
  }

  const cap = liveCapacity(model);
  const owed = model.inFlight - stuck;
  const work =
    model.firstTouches > 0 && owed > 0
      ? `${formatInt(model.firstTouches)} contacts not emailed yet and ${formatInt(owed)} mid-sequence`
      : model.firstTouches > 0
        ? `${plural(model.firstTouches, "contact", "contacts")} not emailed yet`
        : `${plural(owed, "contact", "contacts")} mid-sequence`;
  const parts = [`${work}: ${plural(sim.totalSends, "email", "emails")} left.`];

  // The pool's pace today and, while it ramps, where it ends up.
  const full = model.pool.filter((p) => p.active).reduce((s, p) => s + p.capWarm, 0);
  const ramping = cap.warmingInboxes > 0 && full > cap.capacityToday;
  parts.push(
    `${plural(cap.activeInboxes, "inbox sends", "inboxes send")} ${formatInt(cap.capacityToday)}/day` +
      (ramping
        ? ` now, ${formatInt(full)}/day once warm${sim.rampDoneDate ? ` (${formatCivilDate(sim.rampDoneDate, { year: false })})` : ""}.`
        : "."),
  );

  if (model.firstTouches > 0 && sim.firstTouchesDoneDate) {
    const order = model.strategy === "reach_first" ? "first emails go before follow-ups" : "due follow-ups go first each day";
    parts.push(`Everyone has a first email by ${formatCivilDate(sim.firstTouchesDoneDate, { year: false })} (${order}).`);
  }
  const busy = Math.round(sim.capacityUsedPct);
  if (model.firstTouches > 0 && sim.bottleneck === "new_leads_cap") {
    parts.push(`The ${formatInt(model.newLeadsCap)}/day new-leads cap is the main limit (inboxes ${busy}% busy).`);
  } else if (busy >= 80) {
    parts.push(`Inboxes run ${busy}% busy, so inbox capacity is the main limit.`);
  } else {
    parts.push(`Inboxes run ${busy}% busy on average, so the waits between emails set the date.`);
  }
  parts.push("Assumes nobody replies or bounces.", ...leftOut);

  return result(
    {
      status: "projected",
      dateLabel: formatCivilDate(sim.lastSendDate),
      sendingDays: sim.sendDays,
      weeks: Math.max(1, Math.round(daysBetween(model.today, sim.lastSendDate) / 7)),
      driver: parts.join(" "),
    },
    sim,
  );
}
