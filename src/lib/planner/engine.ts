// Campaign Planner engine: a pure, tick-by-tick replay of the native send
// dispatcher (src/app/api/cron/run-native-sequences/route.ts) over a campaign
// that doesn't exist yet. It reads the dispatcher's own rules from
// src/lib/gmail/ramp.ts instead of restating them, so a plan moves when the
// sender does. Per 5-minute tick inside the send window it replays:
//   - the fetch: up to 40 follow-ups (oldest last action first) and 40 new
//     leads per campaign (route.ts, "Enrollments, per eligible campaign")
//   - the strategy sort: finish_first sends follow-ups first, reach_first new
//     leads first (route.ts enrollmentRank)
//   - the per-tick budget (SENDS_PER_TICK, shared with other campaigns) and one
//     send per inbox per tick (PER_MAILBOX_PER_TICK)
//   - each inbox's day cap from its cumulative sends at the start of the ET day
//     (effectiveDailyCap) and the spacing gate (sendSpacingMinutes)
//   - the per-campaign new-leads/day gate (finish_first only; 0 pauses both)
//   - sticky follow-ups, and first touches to the least-loaded inbox
//   - waits measured from the previous send, in calendar days
// Not modeled (the UI says so): replies or bounces ending a sequence early
// (every contact gets every email, so total sends is an upper bound), Million
// Verifier holds, the 40-second run deadline, and DST.

import {
  ABSOLUTE_MAX_DAILY_CAP,
  NATIVE_TICK_MINUTES,
  PER_MAILBOX_PER_TICK,
  RAMP_STAGES,
  SENDS_PER_TICK,
  effectiveDailyCap,
  sendSpacingMinutes,
} from "@/lib/gmail/ramp";
import { MAX_INBOXES_PER_DOMAIN } from "@/lib/deliverability/provisioning";
import { AVG_DAYS_PER_MONTH } from "@/lib/deliverability/costs";
import type { SendingStrategy } from "@/types/app";
import { formatCivilDate } from "@/lib/format";
import { addDays, daysBetween, isCivil, isWeekend, type CivilDate } from "./dates";

/** Cumulative sends at which an inbox leaves the last warmup stage. */
export const WARMED_AT = RAMP_STAGES[RAMP_STAGES.length - 1].graduateAt;
/** The dispatcher's per-campaign fetch window (route.ts PER_CAMPAIGN_FETCH). */
export const PER_CAMPAIGN_FETCH = SENDS_PER_TICK * 2;
/** Give up after this many calendar days (a plan that never finishes). */
export const SIM_HORIZON_DAYS = 5 * 366;
/** UI-sanity bounds (not dispatcher rules). */
export const MAX_PLANNED_DOMAINS = 200;
export const MAX_SEQUENCE_EMAILS = 10;

/**
 * How the dispatcher narrows follow-ups before its 40-row fetch window.
 * - "none": a flow campaign whose waits sit inside a reply condition, like the
 *   starter template (route.ts only scans top-level graph nodes for a wait, so
 *   it fetches the 40 oldest rows, due or not). The planner default.
 * - "min_wait": a flow campaign with top-level wait nodes (rows older than the
 *   smallest wait).
 * - "exact": a linear campaign (only rows whose own step is due).
 */
export type FollowupPrefilter = "none" | "min_wait" | "exact";

export interface CampaignSimInput {
  /** Contacts that will be sequenced. */
  contacts: number;
  /** wait_days per email, index 0 = the first email (normally 0). */
  waits: number[];
  domains: number;
  inboxesPerDomain: number;
  /** Per-inbox ceiling (native_mailboxes.max_daily_cap). */
  maxDailyCap: number;
  strategy: SendingStrategy;
  /** daily_new_leads_cap: throttles first touches under finish_first; 0 pauses both. */
  newLeadsCap: number;
  weekdaysOnly: boolean;
  /** Send window in the campaign's timezone: start inclusive, end exclusive. */
  startHour: number;
  endHour: number;
  /** sending_domains.max_daily_sends (null = no domain cap, the default). */
  domainDailyCap: number | null;
  /** Other campaigns' sends per day, which share SENDS_PER_TICK. */
  otherSendsPerDay: number;
  /** Inboxes already past the ramp (reused from an earlier campaign). */
  startWarmed: boolean;
  /** First day the campaign can send (inboxes created + warm-up done). */
  launchDate: CivilDate;
  prefilter?: FollowupPrefilter;
  /** Total inboxes when not domains × inboxesPerDomain (the Budget view's pools). */
  inboxes?: number;
  /** Stop after this many calendar days (throughput measurement). */
  horizonDays?: number;
  /** Called on every send (tests use it to check the dispatcher's limits). */
  onSend?: (ev: SendEvent) => void;
}

export interface SendEvent {
  /** Minutes since launch-day midnight. */
  minute: number;
  date: CivilDate;
  inbox: number;
  contact: number;
  /** 0 = the first email. */
  step: number;
  /** The inbox's cap for this day. */
  capToday: number;
}

export interface SimDay {
  date: CivilDate;
  /** Inside the window's days (a weekday when weekdays-only). */
  sendDay: boolean;
  /** Sum of every inbox's day cap. 0 on non-send days. */
  capacity: number;
  firstTouches: number;
  followUps: number;
  /** Inboxes that started the day past the last ramp stage. */
  warmedInboxes: number;
  /** Why first touches stopped while contacts were still waiting for one. */
  newLeadsLimit: "cap" | "capacity" | null;
}

export type SimStatus = "projected" | "paused" | "unreachable";
export type Bottleneck = "new_leads_cap" | "capacity" | "sequence";

export interface SimResult {
  status: SimStatus;
  /** Plain-language reason when status isn't "projected". */
  reason: string | null;
  input: CampaignSimInput;
  inboxes: number;
  /** Launch → last send, one row per calendar day. */
  days: SimDay[];
  launchDate: CivilDate;
  firstTouchesDoneDate: CivilDate | null;
  lastSendDate: CivilDate | null;
  sendDays: number;
  totalSends: number;
  firstTouches: number;
  peakDailySends: number;
  avgDailySends: number;
  /** totalSends ÷ the inboxes' combined day caps over the send days, in %. */
  capacityUsedPct: number;
  /** First day every inbox started fully warmed (null if it never happened). */
  rampDoneDate: CivilDate | null;
  bottleneck: Bottleneck;
}

// ── Input hygiene ──────────────────────────────────────────────────────────
// Every field is clamped and NaN falls back, so a cleared input box can never
// hand the loop a value that keeps it running forever.

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function sanitizeSimInput(x: CampaignSimInput): CampaignSimInput {
  const waitsIn = Array.isArray(x.waits) && x.waits.length > 0 ? x.waits : [0];
  const waits = waitsIn.slice(0, MAX_SEQUENCE_EMAILS).map((w) => clampInt(w, 0, 0, 365));
  const startHour = clampInt(x.startHour, 8, 0, 23);
  const endHour = clampInt(x.endHour, 17, startHour + 1, 24);
  return {
    contacts: clampInt(x.contacts, 0, 0, 1_000_000),
    waits,
    domains: clampInt(x.domains, 1, 1, MAX_PLANNED_DOMAINS),
    inboxesPerDomain: clampInt(x.inboxesPerDomain, MAX_INBOXES_PER_DOMAIN, 1, MAX_INBOXES_PER_DOMAIN),
    maxDailyCap: clampInt(x.maxDailyCap, ABSOLUTE_MAX_DAILY_CAP, 1, ABSOLUTE_MAX_DAILY_CAP),
    strategy: x.strategy === "reach_first" ? "reach_first" : "finish_first",
    newLeadsCap: clampInt(x.newLeadsCap, 0, 0, 1000),
    weekdaysOnly: x.weekdaysOnly !== false,
    startHour,
    endHour,
    domainDailyCap: x.domainDailyCap == null ? null : clampInt(x.domainDailyCap, 0, 1, 1000),
    otherSendsPerDay: clampInt(x.otherSendsPerDay, 0, 0, 1_000_000),
    startWarmed: x.startWarmed === true,
    launchDate: x.launchDate,
    prefilter: x.prefilter ?? "none",
    inboxes:
      x.inboxes == null ? undefined : clampInt(x.inboxes, 1, 1, MAX_PLANNED_DOMAINS * MAX_INBOXES_PER_DOMAIN),
    horizonDays: x.horizonDays == null ? undefined : clampInt(x.horizonDays, SIM_HORIZON_DAYS, 1, SIM_HORIZON_DAYS),
    onSend: x.onSend,
  };
}

// ── The replay ─────────────────────────────────────────────────────────────

export function simulateCampaign(raw: CampaignSimInput): SimResult {
  const input = sanitizeSimInput(raw);
  const S = input.waits.length;
  const I = input.inboxes ?? input.domains * input.inboxesPerDomain;
  const horizon = input.horizonDays ?? SIM_HORIZON_DAYS;
  const base = {
    input,
    inboxes: I,
    launchDate: input.launchDate,
    days: [] as SimDay[],
    firstTouchesDoneDate: null,
    lastSendDate: null,
    sendDays: 0,
    totalSends: 0,
    firstTouches: 0,
    peakDailySends: 0,
    avgDailySends: 0,
    capacityUsedPct: 0,
    rampDoneDate: null,
  };

  if (!isCivil(input.launchDate)) {
    return { ...base, status: "unreachable", reason: "Pick a valid start date.", bottleneck: "sequence" };
  }
  if (input.contacts === 0) {
    return { ...base, status: "unreachable", reason: "Add contacts to plan a campaign.", bottleneck: "sequence" };
  }
  if (input.newLeadsCap <= 0) {
    return {
      ...base,
      status: "paused",
      reason: "New leads per day is 0, which pauses first touches in both strategies. Set it above 0.",
      bottleneck: "new_leads_cap",
    };
  }

  const finishFirst = input.strategy === "finish_first";
  const prefilter = input.prefilter ?? "none";
  const tickMin = NATIVE_TICK_MINUTES;
  const windowStart = input.startHour * 60;
  const windowEnd = input.endHour * 60;
  const mbCfg = { max_daily_cap: input.maxDailyCap, daily_cap_override: null };
  const minFollowWait = S > 1 ? Math.min(...input.waits.slice(1)) : 0;

  // Per-inbox state.
  const totalSent = new Int32Array(I).fill(input.startWarmed ? WARMED_AT : 0);
  const capToday = new Int32Array(I);
  const sentToday = new Int32Array(I);
  const lastSend = new Float64Array(I); // absolute minute of today's last send, -1 = none yet
  const tickStamp = new Int32Array(I).fill(-1); // tick id of this inbox's sends this tick
  const tickCount = new Int32Array(I);
  const domainOf = (mb: number) => Math.floor(mb / input.inboxesPerDomain);
  const domainSent = new Int32Array(Math.ceil(I / input.inboxesPerDomain));

  // Per-contact rows (only contacts that have had a first touch get a row).
  const rowInbox = new Int32Array(input.contacts);
  const rowStep = new Int32Array(input.contacts); // emails sent so far
  const rowLast = new Float64Array(input.contacts); // absolute minute of the last send
  const rowSlot = new Int32Array(input.contacts).fill(-1); // live index in `queue`, -1 = none
  let rows = 0;

  // Follow-up queue, oldest last action first. Sends append to the end (time
  // only moves forward), so it stays sorted; a moved row leaves a stale entry
  // behind, skipped by comparing against rowSlot.
  let queue: number[] = [];
  let head = 0;
  let inflight = 0; // rows that still owe at least one email

  let newRemaining = input.contacts;
  let newToday = 0;
  let otherAcc = 0;
  const otherPerTick = input.otherSendsPerDay / Math.max(1, (windowEnd - windowStart) / tickMin);
  let tickId = 0;

  const days: SimDay[] = [];
  let firstTouchesDoneDate: CivilDate | null = null;
  let lastSendDate: CivilDate | null = null;
  let lastSendIdx = -1;
  let done = false;

  const enqueue = (r: number) => {
    rowSlot[r] = queue.length;
    queue.push(r);
  };
  const isLive = (idx: number) => rowSlot[queue[idx]] === idx;
  const compact = () => {
    const next: number[] = [];
    for (let i = head; i < queue.length; i++) {
      if (isLive(i)) {
        rowSlot[queue[i]] = next.length;
        next.push(queue[i]);
      }
    }
    queue = next;
    head = 0;
  };

  for (let day = 0; day < horizon && !done; day++) {
    const date = addDays(input.launchDate, day);
    const sendDay = !input.weekdaysOnly || !isWeekend(date);
    if (!sendDay) {
      days.push({ date, sendDay, capacity: 0, firstTouches: 0, followUps: 0, warmedInboxes: 0, newLeadsLimit: null });
      continue;
    }

    // Day start (ET midnight): each inbox's cap is pinned to the stage it woke
    // up in (route.ts rampSentAtDayStart), and the day counters reset.
    let capacity = 0;
    let warmed = 0;
    for (let i = 0; i < I; i++) {
      capToday[i] = effectiveDailyCap(mbCfg, totalSent[i]);
      capacity += capToday[i];
      if (totalSent[i] >= WARMED_AT) warmed++;
      sentToday[i] = 0;
      lastSend[i] = -1;
    }
    domainSent.fill(0);
    newToday = 0;
    let dayFirst = 0;
    let dayFollow = 0;
    const dayBase = day * 1440;

    for (let m = windowStart; m < windowEnd; m += tickMin) {
      const now = dayBase + m;
      tickId++;
      otherAcc += otherPerTick;
      const otherNow = Math.floor(otherAcc);
      otherAcc -= otherNow;
      const budget = Math.max(0, SENDS_PER_TICK - otherNow);
      if (budget === 0) continue;
      const windowLeft = windowEnd - m;

      const eligible = (mb: number): boolean => {
        if (sentToday[mb] >= capToday[mb]) return false;
        if (tickStamp[mb] === tickId && tickCount[mb] >= PER_MAILBOX_PER_TICK) return false;
        if (lastSend[mb] >= 0) {
          const gap = sendSpacingMinutes(windowLeft, capToday[mb] - sentToday[mb]);
          if (now - lastSend[mb] < gap) return false;
        }
        if (input.domainDailyCap != null && domainSent[domainOf(mb)] >= input.domainDailyCap) return false;
        return true;
      };
      const send = (r: number, mb: number) => {
        sentToday[mb]++;
        totalSent[mb]++;
        if (tickStamp[mb] !== tickId) {
          tickStamp[mb] = tickId;
          tickCount[mb] = 0;
        }
        tickCount[mb]++;
        lastSend[mb] = now;
        domainSent[domainOf(mb)]++;
        input.onSend?.({ minute: now, date, inbox: mb, contact: r, step: rowStep[r], capToday: capToday[mb] });
        rowInbox[r] = mb;
        rowStep[r]++;
        rowLast[r] = now;
        enqueue(r);
      };

      // Fetch: the 40 oldest follow-up rows that pass the dispatcher's filter.
      while (head < queue.length && !isLive(head)) head++;
      const fetched: number[] = [];
      for (let i = head; i < queue.length && fetched.length < PER_CAMPAIGN_FETCH; i++) {
        if (!isLive(i)) continue;
        const r = queue[i];
        const terminal = rowStep[r] >= S;
        // Flow SQL filters every follow-up row by age; the queue is age-sorted,
        // so the first row too young ends the scan.
        if (prefilter === "min_wait" && rowLast[r] > now - minFollowWait * 1440) break;
        // Linear SQL fetches due rows plus finished ones (to complete them).
        if (prefilter === "exact" && !terminal && now < rowLast[r] + input.waits[rowStep[r]] * 1440) continue;
        fetched.push(r);
      }
      const newDue = newRemaining > 0 && now >= input.waits[0] * 1440;
      const newFetched = newDue ? Math.min(PER_CAMPAIGN_FETCH, newRemaining) : 0;

      let sent = 0;
      const runFollowups = () => {
        for (const r of fetched) {
          if (sent >= budget) return;
          if (rowStep[r] >= S) {
            rowSlot[r] = -1; // finished: the dispatcher completes it on fetch
            continue;
          }
          if (now < rowLast[r] + input.waits[rowStep[r]] * 1440) continue; // not due yet
          const mb = rowInbox[r];
          if (!eligible(mb)) continue; // sticky inbox busy: the row waits
          send(r, mb);
          if (rowStep[r] >= S) inflight--;
          sent++;
          dayFollow++;
        }
      };
      const runNewLeads = () => {
        for (let k = 0; k < newFetched; k++) {
          if (sent >= budget) return;
          if (finishFirst && newToday >= input.newLeadsCap) return;
          // Least-loaded eligible inbox, then most remaining, then lowest id.
          let pick = -1;
          for (let mb = 0; mb < I; mb++) {
            if (!eligible(mb)) continue;
            if (
              pick < 0 ||
              sentToday[mb] < sentToday[pick] ||
              (sentToday[mb] === sentToday[pick] &&
                capToday[mb] - sentToday[mb] > capToday[pick] - sentToday[pick])
            ) {
              pick = mb;
            }
          }
          if (pick < 0) return;
          const r = rows++;
          send(r, pick);
          if (S > 1) inflight++;
          newRemaining--;
          newToday++;
          sent++;
          dayFirst++;
        }
      };
      if (finishFirst) {
        runFollowups();
        runNewLeads();
      } else {
        runNewLeads();
        runFollowups();
      }

      if (newRemaining === 0 && firstTouchesDoneDate === null) firstTouchesDoneDate = date;
      if (newRemaining === 0 && inflight === 0) {
        done = true;
        break;
      }
      if (head > 4096 && head * 2 > queue.length) compact();
    }

    let newLeadsLimit: SimDay["newLeadsLimit"] = null;
    if (newRemaining > 0 && dayBase + windowEnd > input.waits[0] * 1440) {
      newLeadsLimit = finishFirst && newToday >= input.newLeadsCap ? "cap" : "capacity";
    }
    days.push({ date, sendDay, capacity, firstTouches: dayFirst, followUps: dayFollow, warmedInboxes: warmed, newLeadsLimit });
    if (dayFirst + dayFollow > 0) {
      lastSendDate = date;
      lastSendIdx = days.length - 1;
    }
  }

  if (!done) {
    return {
      ...base,
      days,
      status: "unreachable",
      reason: `Not finished within ${Math.round(SIM_HORIZON_DAYS / 365)} years at this setup. Add domains, raise the new-leads cap, or shorten the sequence.`,
      bottleneck: "capacity",
    };
  }

  const kept = days.slice(0, lastSendIdx + 1);
  let totalSends = 0;
  let firstTouches = 0;
  let peak = 0;
  let sendDays = 0;
  let capSum = 0;
  let rampDoneDate: CivilDate | null = null;
  let capDays = 0;
  let capacityDays = 0;
  for (const d of kept) {
    const n = d.firstTouches + d.followUps;
    totalSends += n;
    firstTouches += d.firstTouches;
    if (n > peak) peak = n;
    if (d.sendDay) {
      sendDays++;
      capSum += d.capacity;
      if (rampDoneDate === null && d.warmedInboxes === I) rampDoneDate = d.date;
    }
    if (d.newLeadsLimit === "cap") capDays++;
    if (d.newLeadsLimit === "capacity") capacityDays++;
  }

  // Which limit stopped first touches on more days. A day count can't tell
  // "both bind" from "one binds"; the page asks whatIf() for advice instead.
  // The solver uses this only together with a did-it-move check.
  const bottleneck: Bottleneck =
    capDays > 0 && capDays >= capacityDays ? "new_leads_cap" : capacityDays > 0 ? "capacity" : "sequence";

  return {
    ...base,
    status: "projected",
    reason: null,
    days: kept,
    firstTouchesDoneDate,
    lastSendDate,
    sendDays,
    totalSends,
    firstTouches,
    peakDailySends: peak,
    avgDailySends: sendDays > 0 ? totalSends / sendDays : 0,
    capacityUsedPct: capSum > 0 ? (totalSends / capSum) * 100 : 0,
    rampDoneDate,
    bottleneck,
  };
}

// ── Questions asked of the engine ──────────────────────────────────────────

export interface DomainSolve {
  domains: number | null;
  result: SimResult | null;
  reason: string | null;
}

/**
 * The fewest domains that finish by `finishBy`. Scans upward from a floor that
 * no smaller count could beat (all emails at full warmed capacity), and stops
 * early once inbox capacity is no longer the limit AND one more domain didn't
 * move the finish date: past that point more domains can't help.
 */
export function solveDomains(input: CampaignSimInput, finishBy: CivilDate): DomainSolve {
  const x = sanitizeSimInput(input);
  if (!isCivil(finishBy) || !isCivil(x.launchDate)) {
    return { domains: null, result: null, reason: "Pick valid dates." };
  }
  if (finishBy < x.launchDate) {
    return { domains: null, result: null, reason: "The finish date is before the launch date." };
  }
  let sendDaysAvail = 0;
  for (let d = 0; d <= daysBetween(x.launchDate, finishBy); d++) {
    if (!x.weekdaysOnly || !isWeekend(addDays(x.launchDate, d))) sendDaysAvail++;
  }
  const totalSends = x.contacts * x.waits.length;
  const perDomainPerDay = x.maxDailyCap * x.inboxesPerDomain;
  const floor = Math.max(1, Math.ceil(totalSends / Math.max(1, sendDaysAvail * perDomainPerDay)));
  let prev: SimResult | null = null;
  for (let d = floor; d <= MAX_PLANNED_DOMAINS; d++) {
    const r = simulateCampaign({ ...x, domains: d });
    if (r.status !== "projected") return { domains: null, result: r, reason: r.reason };
    if (r.lastSendDate && r.lastSendDate <= finishBy) return { domains: d, result: r, reason: null };
    const stalled = prev !== null && prev.lastSendDate === r.lastSendDate;
    prev = r;
    if (r.bottleneck !== "capacity" && stalled) {
      return {
        domains: null,
        result: r,
        reason:
          r.bottleneck === "new_leads_cap"
            ? `Not reachable by adding domains: at ${d} domains the new-leads cap (${x.newLeadsCap}/day) is the limit and the last email still goes out ${formatCivilDate(r.lastSendDate, { weekday: true })}. Raise the cap or switch to "Reach everyone first".`
            : `Not reachable by adding domains: at ${d} domains the gaps between emails set the finish (${formatCivilDate(r.lastSendDate, { weekday: true })}). Shorten the sequence or start sooner.`,
      };
    }
  }
  return { domains: null, result: null, reason: `Needs more than ${MAX_PLANNED_DOMAINS} domains.` };
}

export type Limit = "capacity" | "new_leads_cap" | "both" | "sequence";

export interface WhatIf {
  limit: Limit;
  /** The same plan on twice the domains. */
  moreDomains: { domains: number; lastSendDate: CivilDate | null };
  /** The same plan at twice the new-leads cap (finish_first only). */
  higherCap: { newLeadsCap: number; lastSendDate: CivilDate | null } | null;
}

/**
 * What actually moves the finish date, found by trying it: the plan re-run on
 * twice the domains and at twice the new-leads cap. Counting which limit was
 * hit each day can't tell "both bind" from "one binds", and telling someone
 * "more domains won't help" when they would is worse than saying nothing.
 */
export function whatIf(input: CampaignSimInput, base: SimResult): WhatIf | null {
  if (base.status !== "projected" || !base.lastSendDate) return null;
  const x = sanitizeSimInput({ ...input, onSend: undefined });
  const doubled = Math.min(MAX_PLANNED_DOMAINS, x.domains * 2);
  const md = doubled > x.domains ? simulateCampaign({ ...x, domains: doubled }) : base;
  const hc = x.strategy === "finish_first" ? simulateCampaign({ ...x, newLeadsCap: x.newLeadsCap * 2 }) : null;
  const domainsHelp = md.lastSendDate != null && md.lastSendDate < base.lastSendDate;
  const capHelps = hc?.lastSendDate != null && hc.lastSendDate < base.lastSendDate;
  return {
    limit: domainsHelp && capHelps ? "both" : domainsHelp ? "capacity" : capHelps ? "new_leads_cap" : "sequence",
    moreDomains: { domains: doubled, lastSendDate: md.lastSendDate },
    higherCap: hc ? { newLeadsCap: x.newLeadsCap * 2, lastSendDate: hc.lastSendDate } : null,
  };
}

export interface CapSweepRow {
  label: string;
  strategy: SendingStrategy;
  newLeadsCap: number;
  lastSendDate: CivilDate | null;
  sendDays: number;
  status: SimStatus;
}

/** "What if the cap were higher?": the plan re-run at 2× and 3× the cap, and as reach_first. */
export function capSweep(input: CampaignSimInput): CapSweepRow[] {
  const x = sanitizeSimInput(input);
  const cap = Math.max(1, x.newLeadsCap);
  const runs: { label: string; strategy: SendingStrategy; newLeadsCap: number }[] = [
    { label: `Finish first, ${cap}/day`, strategy: "finish_first", newLeadsCap: cap },
    { label: `Finish first, ${cap * 2}/day`, strategy: "finish_first", newLeadsCap: cap * 2 },
    { label: `Finish first, ${cap * 3}/day`, strategy: "finish_first", newLeadsCap: cap * 3 },
    { label: "Reach everyone first", strategy: "reach_first", newLeadsCap: cap },
  ];
  return runs.map((run) => {
    const r = simulateCampaign({ ...x, strategy: run.strategy, newLeadsCap: run.newLeadsCap });
    return { ...run, lastSendDate: r.lastSendDate, sendDays: r.sendDays, status: r.status };
  });
}

export interface MonthThroughput {
  firstTouches: number;
  emails: number;
  sendDays: number;
}

/**
 * What an inbox pool actually sends in each of its first `months` months when
 * the list never runs dry, with the ramp, the new-leads cap, weekend pile-ups
 * and the per-tick budget all included. contacts/launchDate come from `base`
 * except the list size, which is set too large to run out.
 */
export function measureThroughput(base: CampaignSimInput, months: number): MonthThroughput[] {
  const x = sanitizeSimInput({ ...base, contacts: 1 });
  const I = x.inboxes ?? x.domains * x.inboxesPerDomain;
  const horizon = Math.ceil(months * AVG_DAYS_PER_MONTH);
  const ticksPerDay = ((x.endHour - x.startHour) * 60) / NATIVE_TICK_MINUTES;
  const perDay = Math.min(I * x.maxDailyCap, SENDS_PER_TICK * ticksPerDay);
  const contacts = Math.min(1_000_000, Math.ceil(perDay * horizon) + 1);
  const r = simulateCampaign({ ...x, contacts, horizonDays: horizon });
  const out: MonthThroughput[] = Array.from({ length: months }, () => ({ firstTouches: 0, emails: 0, sendDays: 0 }));
  r.days.forEach((d, i) => {
    const m = Math.floor(i / AVG_DAYS_PER_MONTH);
    if (m >= months) return;
    out[m].firstTouches += d.firstTouches;
    out[m].emails += d.firstTouches + d.followUps;
    if (d.sendDay) out[m].sendDays++;
  });
  return out;
}

/** Cumulative sends one fully loaded inbox makes over its first `days` send days. */
export function rampCaps(days: number, maxDailyCap: number): number[] {
  const out: number[] = [];
  let sent = 0;
  for (let d = 0; d < days; d++) {
    const cap = effectiveDailyCap({ max_daily_cap: maxDailyCap, daily_cap_override: null }, sent);
    out.push(cap);
    sent += cap;
  }
  return out;
}
