// Unit tests for the Campaign Planner math (src/lib/planner/*).
//
// The planner replays the native send dispatcher tick by tick, so these tests
// check the replay obeys the dispatcher's own limits (from src/lib/gmail/ramp.ts),
// that every input combination terminates, that dates are civil and weekday-
// correct, and that the economics and budget numbers add up from the shared
// cost constants. The live section checks the same replay started from a
// running campaign (the campaign page's finish date, src/lib/planner/live.ts):
// a run cut at any tick and resumed from its rebuilt state must send exactly
// what the uninterrupted run sends. A drift section fails if the cron schedule
// or the cron's constants stop matching what the planner reads.
//
// Run:  npx tsx scripts/test-planner-math.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ABSOLUTE_MAX_DAILY_CAP,
  NATIVE_TICK_MINUTES,
  PER_MAILBOX_PER_TICK,
  SENDS_PER_TICK,
} from "../src/lib/gmail/ramp";
import { GOOGLE_SEAT_USD_PER_MONTH, SENDING_DOMAIN_USD_PER_YEAR, AVG_DAYS_PER_MONTH } from "../src/lib/deliverability/costs";
import {
  WARMED_AT,
  capSweep,
  rampCaps,
  simulateCampaign,
  solveDomains,
  whatIf,
  type CampaignSimInput,
  type LiveInbox,
  type LiveRow,
  type SendEvent,
} from "../src/lib/planner/engine";
import {
  buildLiveModel,
  followupPrefilter,
  liveCapacity,
  localClock,
  projectLiveCampaign,
  type LiveSnapshot,
} from "../src/lib/planner/live";
import { addDays, addMonths, isWeekend, launchDateFor, weekday } from "../src/lib/planner/dates";
import { campaignEconomics, monthlyChargeCount, type CostInputs, type PricingInputs } from "../src/lib/planner/economics";
import { budgetPlan, budgetLadder, type BudgetInput } from "../src/lib/planner/budget";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

const MONDAY = "2026-10-19";
const BASE: CampaignSimInput = {
  contacts: 600,
  waits: [0, 3, 2],
  domains: 2,
  inboxesPerDomain: 3,
  maxDailyCap: 20,
  strategy: "finish_first",
  newLeadsCap: 20,
  weekdaysOnly: true,
  startHour: 8,
  endHour: 17,
  domainDailyCap: null,
  otherSendsPerDay: 0,
  startWarmed: false,
  launchDate: MONDAY,
};

function run(over: Partial<CampaignSimInput>) {
  const events: SendEvent[] = [];
  const r = simulateCampaign({ ...BASE, ...over, onSend: (e) => events.push(e) });
  return { r, events };
}

// Every dispatcher limit, checked against the send log of one run.
function checkLimits(label: string, over: Partial<CampaignSimInput>) {
  const { r, events } = run(over);
  const x = { ...BASE, ...over };
  const S = x.waits.length;
  ok(r.status === "projected", `${label}: projected`);
  ok(r.firstTouches === x.contacts, `${label}: every contact gets a first email (${r.firstTouches})`);
  ok(r.totalSends === x.contacts * S && events.length === r.totalSends, `${label}: sends = contacts × emails (${r.totalSends})`);

  const perTick = new Map<number, number>();
  const perInboxTick = new Map<string, number>();
  const perInboxDay = new Map<string, number>();
  const lastByContact = new Map<number, SendEvent>();
  let weekendSends = 0;
  let outOfWindow = 0;
  let gapViolations = 0;
  let orderViolations = 0;
  let capViolations = 0;
  let stickyViolations = 0;
  for (const e of events) {
    perTick.set(e.minute, (perTick.get(e.minute) ?? 0) + 1);
    const it = `${e.minute}:${e.inbox}`;
    perInboxTick.set(it, (perInboxTick.get(it) ?? 0) + 1);
    const id = `${e.date}:${e.inbox}`;
    const n = (perInboxDay.get(id) ?? 0) + 1;
    perInboxDay.set(id, n);
    if (n > e.capToday || e.capToday > ABSOLUTE_MAX_DAILY_CAP) capViolations++;
    if (x.weekdaysOnly && isWeekend(e.date)) weekendSends++;
    const mod = e.minute % 1440;
    if (mod < x.startHour * 60 || mod >= x.endHour * 60 || mod % NATIVE_TICK_MINUTES !== 0) outOfWindow++;
    const prev = lastByContact.get(e.contact);
    if (prev) {
      if (e.step !== prev.step + 1) orderViolations++;
      if (e.minute < prev.minute + x.waits[e.step] * 1440) gapViolations++;
      if (e.inbox !== prev.inbox) stickyViolations++;
    } else if (e.step !== 0) {
      orderViolations++;
    }
    lastByContact.set(e.contact, e);
  }
  ok(Math.max(...perTick.values()) <= SENDS_PER_TICK, `${label}: at most ${SENDS_PER_TICK} sends per tick`);
  ok(Math.max(...perInboxTick.values()) <= PER_MAILBOX_PER_TICK, `${label}: at most ${PER_MAILBOX_PER_TICK} send per inbox per tick`);
  ok(capViolations === 0, `${label}: no inbox exceeds its day cap (or 20)`);
  ok(weekendSends === 0, `${label}: no weekend sends`);
  ok(outOfWindow === 0, `${label}: every send on a tick inside the window`);
  ok(orderViolations === 0, `${label}: each contact's emails go out in order`);
  ok(gapViolations === 0, `${label}: every follow-up waits at least wait_days × 24h`);
  ok(stickyViolations === 0, `${label}: follow-ups stay on the contact's first inbox`);
  return { r, events };
}

console.log("Termination and input hygiene:");
{
  const paused = simulateCampaign({ ...BASE, newLeadsCap: 0 });
  ok(paused.status === "paused", "new-leads cap 0 → paused, no loop");
  const empty = simulateCampaign({ ...BASE, contacts: Number.NaN });
  ok(empty.status === "unreachable" && empty.totalSends === 0, "NaN contacts → sanitized to 0, no loop");
  const odd = simulateCampaign({ ...BASE, domains: Number.NaN, inboxesPerDomain: 99, maxDailyCap: 50 });
  ok(odd.inboxes === 3 && odd.input.maxDailyCap === ABSOLUTE_MAX_DAILY_CAP, "NaN domains → 1; 99 inboxes/domain → 3; cap 50 → 20");
  const t0 = Date.now();
  const never = simulateCampaign({ ...BASE, contacts: 1_000_000, domains: 1, startHour: 8, endHour: 9 });
  ok(never.status === "unreachable", `impossible plan stops at the horizon (${Date.now() - t0}ms)`);
  const badDate = simulateCampaign({ ...BASE, launchDate: "2026-13-40" });
  ok(badDate.status === "unreachable", "invalid launch date → unreachable");
}

console.log("Ramp:");
{
  const caps = rampCaps(17, 20);
  ok(caps.join(",") === "5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,20", `fully loaded inbox: ${caps.join(",")}`);
  ok(caps.slice(0, 15).reduce((a, b) => a + b, 0) === WARMED_AT, `first 15 days sum to the last graduateAt (${WARMED_AT})`);
  // One inbox, a long list, reach_first: it sends exactly its ramp each weekday.
  const { events } = run({ contacts: 5000, domains: 1, inboxesPerDomain: 1, strategy: "reach_first" });
  const byDate = new Map<string, number>();
  for (const e of events) byDate.set(e.date, (byDate.get(e.date) ?? 0) + 1);
  const firstDays = [...byDate.values()].slice(0, 17);
  ok(firstDays.join(",") === caps.join(","), `one inbox sends its ramp day by day (${firstDays.join(",")})`);
  const warm = simulateCampaign({ ...BASE, startWarmed: true });
  ok(warm.days[0].capacity === 6 * 20, "start warmed → full capacity on launch day");
}

console.log("Dispatcher limits (finish_first, 2 domains):");
const ff = checkLimits("finish_first", {});
{
  const perDayNew = new Map<string, number>();
  for (const e of ff.events) if (e.step === 0) perDayNew.set(e.date, (perDayNew.get(e.date) ?? 0) + 1);
  ok(Math.max(...perDayNew.values()) <= BASE.newLeadsCap, `first touches per day ≤ the new-leads cap (${Math.max(...perDayNew.values())})`);
}
console.log("Dispatcher limits (reach_first, 3 domains):");
const rf = checkLimits("reach_first", { domains: 3, contacts: 2000, strategy: "reach_first" });
ok(rf.r.days[0].firstTouches === rf.r.days[0].capacity, `reach_first fills day 1 with first touches (${rf.r.days[0].firstTouches}/${rf.r.days[0].capacity})`);
console.log("Dispatcher limits (linear prefilter, domain cap, other campaigns):");
checkLimits("exact prefilter", { prefilter: "exact" });
checkLimits("domain cap 30", { domainDailyCap: 30, contacts: 300 });
checkLimits("1,000 other sends/day", { otherSendsPerDay: 1000, contacts: 300 });

console.log("Weekends and civil dates:");
{
  const wed = "2026-10-21";
  ok(weekday(MONDAY) === 1 && weekday(wed) === 3, "2026-10-19 is a Monday, 2026-10-21 a Wednesday");
  const fri = run({ contacts: 1, waits: [0, 2], launchDate: wed }).events;
  ok(fri[1]?.date === "2026-10-23" && fri[1].minute % 1440 === 8 * 60, "a 2-day wait from Wednesday 8:00 sends Friday 8:00");
  const mon = run({ contacts: 1, waits: [0, 3], launchDate: wed }).events;
  ok(mon[1]?.date === "2026-10-26" && mon[1].minute % 1440 === 8 * 60, "a follow-up due Saturday goes Monday 8:00");
  ok(launchDateFor("2026-10-03", 14) === MONDAY, "Saturday start + 14 days (a Saturday) → launches Monday");
  ok(launchDateFor("2026-10-02", 0) === "2026-10-02", "Friday start + 0 days → launches that Friday");
  ok(addMonths("2026-01-31", 1) === "2026-02-28", "Jan 31 + 1 month → Feb 28");
  ok(addDays("2026-12-31", 1) === "2027-01-01", "Dec 31 + 1 day → Jan 1");
}

console.log("Domains vs the new-leads cap:");
{
  const ten = simulateCampaign({ ...BASE, contacts: 1000, domains: 10 });
  const twenty = simulateCampaign({ ...BASE, contacts: 1000, domains: 20 });
  ok(ten.bottleneck === "new_leads_cap", `10 domains at cap 20/day → the cap is the bottleneck`);
  ok(ten.lastSendDate === twenty.lastSendDate, `20 domains finish the same day as 10 (${ten.lastSendDate})`);
  const sweep = capSweep({ ...BASE, contacts: 1000, domains: 10 });
  ok(sweep.length === 4 && (sweep[1].lastSendDate ?? "") < (sweep[0].lastSendDate ?? ""), "doubling the cap finishes sooner");
  // The advice is counterfactual: it says "domains won't help" only when they don't.
  const oneIn = { ...BASE, contacts: 1000, domains: 1 };
  const oneSim = simulateCampaign(oneIn);
  const one = whatIf(oneIn, oneSim);
  ok(
    one != null && (one.limit === "both" || one.limit === "capacity") && (one.moreDomains.lastSendDate ?? "") < (oneSim.lastSendDate ?? ""),
    `1 domain: twice the domains finishes sooner, advice "${one?.limit}"`,
  );
  const tenIn = { ...BASE, contacts: 1000, domains: 10 };
  const tenAdvice = whatIf(tenIn, simulateCampaign(tenIn));
  ok(tenAdvice?.limit === "new_leads_cap", `10 domains at cap 20/day: only the cap moves the finish ("${tenAdvice?.limit}")`);
}

console.log("Solver:");
{
  const x: CampaignSimInput = { ...BASE, contacts: 900, strategy: "reach_first", domains: 1 };
  const finishBy = "2026-11-20";
  let brute: number | null = null;
  for (let d = 1; d <= 20 && brute === null; d++) {
    const r = simulateCampaign({ ...x, domains: d });
    if (r.lastSendDate && r.lastSendDate <= finishBy) brute = d;
  }
  const solved = solveDomains(x, finishBy);
  ok(brute !== null && solved.domains === brute, `fewest domains to finish by ${finishBy}: solver ${solved.domains}, brute force ${brute}`);
  const capped = solveDomains({ ...BASE, contacts: 2000 }, finishBy);
  ok(capped.domains === null && /cap/.test(capped.reason ?? ""), "cap-bound target → unreachable, and the reason names the cap");
}

console.log("Economics:");
{
  const sim = simulateCampaign({ ...BASE, contacts: 1000, domains: 1 });
  const cost: CostInputs = {
    startDate: "2026-10-05",
    contactsMode: "we_source",
    listSize: 1000,
    sendablePct: 100,
    sourcingUsdPerContact: 0.08,
    seatUsdPerMonth: GOOGLE_SEAT_USD_PER_MONTH,
    domainUsdPerYear: SENDING_DOMAIN_USD_PER_YEAR,
    domainBasis: "dedicated",
    drainDays: 14,
    otherMonthlyUsd: 0,
  };
  const price: PricingInputs = {
    monthlyRetainerUsd: 1500,
    setupFeeUsd: 0,
    sourcingPriceUsdPerContact: 0,
    monthlyChargesOverride: null,
    paymentFeePct: 2.9,
    paymentFeeFixedUsd: 0.3,
  };
  const e = campaignEconomics(sim, cost, price, { replyRatePct: 3, positiveRatePct: 40 });
  const seats = e.costs.find((c) => c.key === "seats")!.amount;
  ok(Math.abs(seats - 3 * GOOGLE_SEAT_USD_PER_MONTH * (e.seatDays / AVG_DAYS_PER_MONTH)) < 1e-9, "seats = inboxes × seat × days ÷ avg month");
  ok(e.seatDays === 133, `seat days run start → last send + 14-day drain (${e.seatDays})`);
  ok(monthlyChargeCount(MONDAY, "2027-02-01") === 4 && e.monthlyCharges === 4, "charges on Oct 19, Nov 19, Dec 19, Jan 19 → 4");
  ok(Math.abs(e.totalCost + e.margin - e.totalRevenue) < 1e-9, "margin = revenue − cost");
  const atBreakeven = campaignEconomics(sim, cost, { ...price, monthlyRetainerUsd: e.breakevenMonthly ?? 0 }, { replyRatePct: null, positiveRatePct: null });
  ok(Math.abs(atBreakeven.margin) < 0.01, `breakeven retainer ${e.breakevenMonthly?.toFixed(2)}/mo → margin ${atBreakeven.margin.toFixed(4)}`);
  ok(e.outcomes?.replies === 30 && Math.abs((e.outcomes?.positives ?? 0) - 12) < 1e-9, "3% replies, 40% positive on 1,000 → 30 and 12");
}

console.log("Budget:");
{
  const b: BudgetInput = {
    monthlyBudgetUsd: 100,
    waits: [0, 3, 2],
    campaigns: 1,
    strategy: "reach_first",
    newLeadsCap: 20,
    weekdaysOnly: true,
    startHour: 8,
    endHour: 17,
    maxDailyCap: 20,
    inboxesPerDomain: 3,
    weSource: false,
    sourcingUsdPerContact: 0.08,
    seatUsdPerMonth: GOOGLE_SEAT_USD_PER_MONTH,
    domainUsdPerYear: SENDING_DOMAIN_USD_PER_YEAR,
    otherSendsPerDay: 0,
    launchDate: MONDAY,
  };
  const p = budgetPlan(b);
  const costOf = (i: number) => i * GOOGLE_SEAT_USD_PER_MONTH + (Math.ceil(i / 3) * SENDING_DOMAIN_USD_PER_YEAR) / 12;
  ok(costOf(p.affordableInboxes) <= 100 && costOf(p.affordableInboxes + 1) > 100, `$100 affords ${p.affordableInboxes} inboxes, one more doesn't fit`);
  ok(p.monthlyCost <= 100 && p.limitedBy === "budget", `client-supplied reach_first: budget-limited, $${p.monthlyCost.toFixed(2)}/mo`);
  ok(p.contactsMonth1 < p.contactsPerMonth, "month 1 (ramping) carries fewer contacts than steady state");
  const capped = budgetPlan({ ...b, strategy: "finish_first", monthlyBudgetUsd: 500 });
  ok(capped.limitedBy === "new_leads_cap" && capped.inboxes < capped.affordableInboxes, `finish_first $500: cap-limited, buys ${capped.inboxes} of ${capped.affordableInboxes} affordable inboxes`);
  ok(capped.contactsPerMonth <= 20 * 23 * 1.02, `cap-limited contacts stay under the cap × send days (${capped.contactsPerMonth.toFixed(0)}/mo)`);
  const ladder = budgetLadder(b);
  ok(ladder.length === 5 && ladder.every((r, i) => i === 0 || r.inboxes >= ladder[i - 1].inboxes), "ladder: 5 rows, inboxes never fall as budget rises");
  const top = ladder[ladder.length - 1];
  ok(top.emailsPerDay <= top.platformCeilingPerDay, `$1,000 reach_first stays under the dispatcher ceiling (${top.emailsPerDay.toFixed(0)} ≤ ${top.platformCeilingPerDay}/day)`);
}

// ── Live campaigns ──────────────────────────────────────────────────────────

// Cut a plan's run after the tick at `atMinute` on day `k`, rebuild the live
// state it is in from its send log (what live-send-state.ts reads from the
// database: ramp counts, today's sends, each contact's step, last send and
// sticky inbox, today's first emails), resume from there, and compare every
// later send with the uninterrupted run.
function resumeAt(x: CampaignSimInput, k: number, atMinute: number) {
  const events: SendEvent[] = [];
  const completedAt = new Map<number, number>();
  const full = simulateCampaign({
    ...x,
    onSend: (e) => events.push(e),
    onComplete: (c, m) => completedAt.set(c, m),
  });
  const I = x.inboxes ?? x.domains * x.inboxesPerDomain;
  const dayStart = k * 1440;
  const cut = dayStart + atMinute;
  const before = events.filter((e) => e.minute <= cut);
  const after = events.filter((e) => e.minute > cut);
  const inboxes: LiveInbox[] = Array.from({ length: I }, (_, i) => {
    const mine = before.filter((e) => e.inbox === i);
    const today = mine.filter((e) => e.minute >= dayStart);
    return {
      rampSentAtDayStart: (x.startWarmed ? WARMED_AT : 0) + mine.length - today.length,
      sentToday: today.length,
      lastSendMinute: today.length > 0 ? today[today.length - 1].minute - dayStart : null,
      maxDailyCap: x.maxDailyCap,
      dailyCapOverride: null,
      active: true,
      takesNewLeads: true,
      domain: x.domainDailyCap != null ? Math.floor(i / x.inboxesPerDomain) : null,
    };
  });
  // The follow-up queue in its own order: by each contact's last send.
  const last = new Map<number, { step: number; minute: number; inbox: number; order: number }>();
  before.forEach((e, order) => last.set(e.contact, { step: e.step + 1, minute: e.minute, inbox: e.inbox, order }));
  const rows: LiveRow[] = [...last.entries()]
    .filter(([c]) => !((completedAt.get(c) ?? Infinity) <= cut))
    .sort((a, b) => a[1].order - b[1].order)
    .map(([, r]) => ({ step: r.step, lastActionMinute: r.minute - dayStart, inbox: r.inbox }));
  const domains =
    x.domainDailyCap != null
      ? Array.from({ length: Math.ceil(I / x.inboxesPerDomain) }, (_, d) => ({
          cap: x.domainDailyCap,
          sentToday: before.filter((e) => e.minute >= dayStart && Math.floor(e.inbox / x.inboxesPerDomain) === d).length,
        }))
      : [];
  const resumedEvents: SendEvent[] = [];
  const resumed = simulateCampaign({
    ...x,
    contacts: x.contacts - before.filter((e) => e.step === 0).length,
    launchDate: addDays(x.launchDate, k),
    live: {
      inboxes,
      rows,
      nowMinute: atMinute,
      newLeadsToday: before.filter((e) => e.step === 0 && e.minute >= dayStart).length,
      domains,
    },
    onSend: (e) => resumedEvents.push(e),
  });
  const key = (e: SendEvent, offset: number) => `${e.minute - offset}|${e.inbox}|${e.step}`;
  const same = after.map((e) => key(e, dayStart)).join(",") === resumedEvents.map((e) => key(e, 0)).join(",");
  return { full, resumed, same, after: after.length, history: before.length, inFlight: rows.length };
}

console.log("Live campaigns: a run resumed from its rebuilt state sends exactly what the whole run sends:");
{
  const cases: { label: string; x: CampaignSimInput; k: number; at: number }[] = [
    { label: "no history yet (a fresh plan)", x: BASE, k: 0, at: 0 },
    { label: "finish_first, waits in a reply branch, day 9 at 11:00", x: BASE, k: 9, at: 11 * 60 },
    {
      label: "reach_first, top-level flow waits, day 23 at 14:35",
      x: { ...BASE, contacts: 2000, domains: 3, strategy: "reach_first", prefilter: "min_wait", waits: [0, 4, 9, 9] },
      k: 23,
      at: 14 * 60 + 35,
    },
    { label: "linear, warmed, right after the 8:00 tick on day 4", x: { ...BASE, prefilter: "exact", startWarmed: true, contacts: 900 }, k: 4, at: 8 * 60 },
    {
      label: "domain cap 25 and 2 other sends a tick, day 12 at 9:55",
      x: { ...BASE, domainDailyCap: 25, otherSendsPerDay: 2 * 108, contacts: 800 },
      k: 12,
      at: 9 * 60 + 55,
    },
    {
      label: "cold ramp, cap 15, long waits, after the day's last tick (day 6)",
      x: { ...BASE, waits: [0, 2, 4, 7], newLeadsCap: 15, contacts: 500 },
      k: 6,
      at: 16 * 60 + 55,
    },
  ];
  for (const c of cases) {
    const r = resumeAt(c.x, c.k, c.at);
    ok(
      r.same && r.resumed.lastSendDate === r.full.lastSendDate && r.resumed.status === "projected",
      `${c.label}: ${r.history} sends before, ${r.inFlight} contacts mid-sequence, ${r.after} after, last send ${r.resumed.lastSendDate}`,
    );
  }
}

// A snapshot shaped like live-send-state.ts's reads: Monday 9:07:30 Pacific.
const SNAP: LiveSnapshot = {
  now: "2026-10-05T16:07:30.000Z",
  campaign: {
    daily_new_leads_cap: 20,
    sending_strategy: "finish_first",
    send_timezone: "America/Los_Angeles",
    send_start_hour: 8,
    send_end_hour: 12,
    send_weekdays_only: true,
    flow_graph: null,
  },
  waits: [0, 5, 3],
  poolIds: ["mb-a", "mb-b", "mb-c", "mb-d"],
  mailboxes: [
    // Re-warming after a rest: 300 sends all time, ramp_baseline_sent 280.
    { id: "mb-b", status: "active", max_daily_cap: 20, daily_cap_override: null, ramp_baseline_sent: 280, domain_id: "dom-1", total_sent: 300 },
    { id: "mb-a", status: "active", max_daily_cap: 20, daily_cap_override: null, ramp_baseline_sent: 0, domain_id: "dom-1", total_sent: 40 },
    { id: "mb-c", status: "paused", max_daily_cap: 20, daily_cap_override: null, ramp_baseline_sent: 0, domain_id: "dom-1", total_sent: 900 },
    // On a resting domain: finishes its threads but takes no new leads.
    { id: "mb-d", status: "active", max_daily_cap: 20, daily_cap_override: null, ramp_baseline_sent: 0, domain_id: "dom-2", total_sent: 500 },
  ],
  sendsToday: [
    ...["15:00:10", "15:12:40", "15:25:05", "15:40:00", "16:00:20"].map((t) => ({ mailbox_id: "mb-b", sent_at: `2026-10-05T${t}.000Z` })),
    ...["15:05:00", "15:35:00"].map((t) => ({ mailbox_id: "mb-a", sent_at: `2026-10-05T${t}.000Z` })),
  ],
  newLeadsToday: 3,
  enrollments: [
    ...Array.from({ length: 4 }, () => ({
      current_step_index: 0,
      last_action_at: null,
      started_at: "2026-09-30T18:00:00.000Z",
      native_mailbox_id: null,
      gmail_thread_id: null,
    })),
    ...["mb-a", "mb-a", "mb-c", "mb-d"].map((mb) => ({
      current_step_index: 1,
      last_action_at: "2026-10-01T16:00:00.000Z",
      started_at: "2026-09-30T18:00:00.000Z",
      native_mailbox_id: mb,
      gmail_thread_id: "t",
    })),
    // Its inbox was deleted mid-thread (FK set null, thread kept): route.ts fails it.
    { current_step_index: 1, last_action_at: "2026-10-01T16:00:00.000Z", started_at: null, native_mailbox_id: null, gmail_thread_id: "t" },
  ],
  domains: [
    { id: "dom-1", lifecycle_status: "active", max_daily_sends: null, sent_today: 0 },
    { id: "dom-2", lifecycle_status: "resting", max_daily_sends: null, sent_today: 0 },
  ],
  otherSendsPerDay: 0,
};

console.log("Live campaigns: reading the snapshot the way the dispatcher does:");
{
  const pdt = localClock(new Date(SNAP.now), "America/Los_Angeles");
  ok(pdt.date === "2026-10-05" && pdt.minute === 9 * 60 + 7.5, `16:07:30Z is 9:07:30 Pacific on Oct 5 (minute ${pdt.minute})`);
  const pst = localClock(new Date("2026-12-01T17:00:00.000Z"), "America/Los_Angeles");
  ok(pst.date === "2026-12-01" && pst.minute === 9 * 60, "17:00Z is 9:00 Pacific in December (standard time)");
  ok(followupPrefilter(null).prefilter === "exact", "no flow graph → linear fetch (each row's own step)");
  ok(followupPrefilter({ nodes: [] }).prefilter === "exact", "an empty graph falls back to linear, as route.ts does");
  ok(followupPrefilter({ nodes: [{ kind: "email" }, { kind: "condition" }] }).prefilter === "none", "waits inside a reply condition → no age filter");
  const mw = followupPrefilter({ nodes: [{ kind: "email" }, { kind: "wait", wait_days: 9 }, { kind: "email" }, { kind: "wait", wait_days: 4 }] });
  ok(mw.prefilter === "min_wait" && mw.waitDays === 4, "top-level waits 9 and 4 → rows older than 4 days");
  ok(followupPrefilter({ nodes: [{ kind: "wait", wait_days: 0 }, { kind: "wait", wait_days: 3 }] }).prefilter === "none", "a zero top-level wait → no age filter");

  const m = buildLiveModel(SNAP);
  const live = m.input.live!;
  const byId = (id: string) => live.inboxes[["mb-a", "mb-b", "mb-c", "mb-d"].indexOf(id)];
  ok(m.today === "2026-10-05" && live.nowMinute === 9 * 60 + 7.5, "day 0 is today in the window's zone, resuming at 9:07:30");
  ok(byId("mb-b").rampSentAtDayStart === 15 && m.pool.find((p) => p.id === "mb-b")?.capToday === 7, "ramp_baseline_sent: 300 sent − 280 baseline − 5 today = 15 → cap 7 (not 20)");
  ok(byId("mb-a").rampSentAtDayStart === 38 && m.pool.find((p) => p.id === "mb-a")?.capToday === 10, "today's sends don't move today's cap: 40 − 2 today = 38 → cap 10");
  ok(Math.abs((byId("mb-b").lastSendMinute ?? 0) - (9 * 60 + 0 + 20 / 60)) < 1e-9, "the spacing gate reads today's last send (9:00:20 Pacific)");
  ok(!byId("mb-c").active && byId("mb-d").active && !byId("mb-d").takesNewLeads, "paused inbox can't send; a resting domain's inbox sends follow-ups only");
  ok(m.firstTouches === 4 && m.inFlight === 4 && m.orphaned === 1 && m.input.prefilter === "exact", "4 queued first emails, 4 mid-sequence, 1 orphan; linear fetch");
  const cap = liveCapacity(m);
  ok(cap.activeInboxes === 3 && cap.capacityToday === 7 + 10 + 20 && cap.remainingToday === 2 + 8 + 20, `pool capacity counts active inboxes at today's caps (${cap.capacityToday}/day, ${cap.remainingToday} left)`);

  const p = projectLiveCampaign(SNAP);
  ok(p.projection.status === "projected" && p.sim?.stuckRows === 1, `the contact on the paused inbox is left out (${p.projection.dateLabel})`);
  ok(/paused or errored inbox/.test(p.projection.driver) && /lost its inbox/.test(p.projection.driver), "the banner says who is left out and why");
  ok(p.sim!.days[0].date === "2026-10-05" && p.sim!.days[0].firstTouches <= 2 + 8, "today's first emails fit what the pool inboxes have left today");
}

console.log("Live campaigns: the four flaws of the old projection:");
{
  const snapWith = (over: Partial<LiveSnapshot>): LiveSnapshot => ({ ...SNAP, ...over });
  const pool3 = (total: number) =>
    ["mb-a", "mb-b", "mb-c"].map((id) => ({
      id,
      status: "active",
      max_daily_cap: 20,
      daily_cap_override: null,
      ramp_baseline_sent: 0,
      domain_id: null,
      total_sent: total,
    }));
  const queued = (n: number) =>
    Array.from({ length: n }, () => ({
      current_step_index: 0,
      last_action_at: null,
      started_at: "2026-10-01T16:00:00.000Z",
      native_mailbox_id: null,
      gmail_thread_id: null,
    }));
  // 7:00 Pacific on a Monday: today's whole window is still ahead.
  const base = { now: "2026-10-05T14:00:00.000Z", poolIds: ["mb-a", "mb-b", "mb-c"], sendsToday: [], newLeadsToday: 0, domains: [] };

  // 1. The ramp: cold inboxes climb a stage a day instead of holding today's cap.
  const ramp = projectLiveCampaign(
    snapWith({ ...base, mailboxes: pool3(0), enrollments: queued(3000), campaign: { ...SNAP.campaign, sending_strategy: "reach_first" } }),
  );
  const caps = ramp.sim!.days.filter((d) => d.sendDay).slice(0, 4).map((d) => d.capacity);
  ok(caps.join(",") === "15,18,21,24", `3 cold inboxes: ${caps.join(", ")} a day, not 15 forever`);

  // 2. Follow-ups share each inbox's day: due follow-ups go first under
  // finish_first. (12 per inbox keeps all 36 inside the 40-row fetch window.)
  const due = ["mb-a", "mb-b", "mb-c"].flatMap((mb) =>
    Array.from({ length: 12 }, () => ({
      current_step_index: 1,
      last_action_at: "2026-09-28T15:30:00.000Z",
      started_at: "2026-09-25T16:00:00.000Z",
      native_mailbox_id: mb,
      gmail_thread_id: "t",
    })),
  );
  const shared = projectLiveCampaign(snapWith({ ...base, mailboxes: pool3(32), enrollments: [...due, ...queued(100)] }));
  const d0 = shared.sim!.days[0];
  ok(d0.followUps === 27 && d0.firstTouches === 0, `36 due follow-ups on 27/day of capacity: ${d0.followUps} follow-ups, ${d0.firstTouches} first emails today (not 20)`);

  // 3. finish_first's cap is a ceiling, not a rate: 80/day on one cold inbox is 5/day.
  const capped = projectLiveCampaign(
    snapWith({
      ...base,
      poolIds: ["mb-a"],
      mailboxes: pool3(0).slice(0, 1),
      enrollments: queued(200),
      campaign: { ...SNAP.campaign, daily_new_leads_cap: 80 },
    }),
  );
  ok(capped.sim!.days[0].firstTouches === 5, `new-leads cap 80 on one cold inbox: ${capped.sim!.days[0].firstTouches} first emails on day 1`);

  // 4. ramp_baseline_sent: a re-warming inbox starts back at stage 1.
  const rewarm = projectLiveCampaign(
    snapWith({
      ...base,
      poolIds: ["mb-a"],
      mailboxes: [{ ...pool3(900)[0], ramp_baseline_sent: 900 }],
      enrollments: queued(50),
    }),
  );
  ok(rewarm.sim!.days[0].capacity === 5, `900 sent, baseline 900: back to ${rewarm.sim!.days[0].capacity}/day`);
}

console.log("Live campaigns: banner states:");
{
  const p = (over: Partial<LiveSnapshot>) => projectLiveCampaign({ ...SNAP, ...over }).projection;
  ok(p({ waits: [] }).status === "unknown", "no steps → unknown");
  ok(p({ enrollments: [] }).status === "done", "no active contacts → done");
  ok(p({ campaign: { ...SNAP.campaign, daily_new_leads_cap: 0 } }).status === "paused", "first emails queued at 0 new leads a day → paused");
  const benched = SNAP.mailboxes.map((m) => ({ ...m, status: "error" }));
  const noInbox = p({ mailboxes: benched });
  ok(noInbox.status === "unknown" && /can take new leads/.test(noInbox.driver), "every pool inbox benched → unknown, and says why");
  const finished = p({
    enrollments: [{ current_step_index: 3, last_action_at: "2026-10-02T16:00:00.000Z", started_at: null, native_mailbox_id: "mb-a", gmail_thread_id: "t" }],
  });
  ok(finished.status === "done", "only contacts past their last email → done");
  const stuck = p({
    enrollments: [{ current_step_index: 1, last_action_at: "2026-10-01T16:00:00.000Z", started_at: null, native_mailbox_id: "mb-c", gmail_thread_id: "t" }],
  });
  ok(stuck.status === "unknown" && /Resume it/.test(stuck.driver), "everyone left waits on a paused inbox → unknown");
  const orphansOnly = p({
    enrollments: [{ current_step_index: 1, last_action_at: "2026-10-01T16:00:00.000Z", started_at: null, native_mailbox_id: null, gmail_thread_id: "t" }],
  });
  ok(orphansOnly.status === "done" && /will fail/.test(orphansOnly.driver), "only contacts whose inbox was deleted → done, and says they will fail");
  const projected = p({});
  ok(
    projected.status === "projected" && /^[A-Z][a-z]{2} \d{1,2}, 20\d\d$/.test(projected.dateLabel ?? "") && (projected.weeks ?? 0) >= 1,
    `projected → "${projected.dateLabel}", ${projected.weeks} week(s)`,
  );
  ok(!/\u2014|\u2013/.test(projected.driver), "the banner copy has no em or en dashes");
}

console.log("Drift guards:");
{
  const root = join(__dirname, "..");
  const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
    crons?: { path: string; schedule: string }[];
  };
  const cron = vercel.crons?.find((c) => c.path.endsWith("/run-native-sequences"));
  ok(cron?.schedule === `*/${NATIVE_TICK_MINUTES} * * * *`, `vercel.json runs run-native-sequences every ${NATIVE_TICK_MINUTES} min (${cron?.schedule})`);
  const route = readFileSync(join(root, "src/app/api/cron/run-native-sequences/route.ts"), "utf8");
  ok(!/const\s+(SENDS_PER_TICK|PER_MAILBOX_PER_TICK)\s*=/.test(route), "the cron imports SENDS_PER_TICK / PER_MAILBOX_PER_TICK instead of its own copies");
  const engine = readFileSync(join(root, "src/lib/planner/engine.ts"), "utf8");
  ok(/effectiveDailyCap/.test(engine) && /sendSpacingMinutes/.test(engine) && /RAMP_STAGES/.test(engine), "the engine reads the ramp + spacing rules from ramp.ts");
  // The live replay reads the cron's fetch rules (src/lib/planner/live.ts mirrors them).
  ok(
    /for \(const n of graph\.nodes\)/.test(route) && /minWait > 0/.test(route) && /\.lte\("last_action_at"/.test(route),
    "the cron still filters flow follow-ups by the smallest top-level wait (live.ts followupPrefilter)",
  );
  ok(
    /\.order\("last_action_at", \{ ascending: true \}\)/.test(route) && /\.order\("started_at", \{ ascending: true \}\)/.test(route),
    "the cron still fetches follow-ups oldest action first and new leads oldest start first",
  );
  ok(
    /rampSentAtDayStart/.test(route) && /ramp_baseline_sent/.test(route),
    "the cron still pins the day's cap to the start-of-day ramp count, after ramp_baseline_sent",
  );
  const page = readFileSync(join(root, "src/app/(dashboard)/admin/campaigns/[id]/page.tsx"), "utf8");
  const heartbeat = readFileSync(join(root, "src/lib/notifications/owner-heartbeat.ts"), "utf8");
  const rampSrc = readFileSync(join(root, "src/lib/gmail/ramp.ts"), "utf8");
  ok(
    /projectLiveCampaign/.test(page) && /projectLiveCampaign/.test(heartbeat) && !/projectSequenceCompletion/.test(page + heartbeat + rampSrc),
    "the campaign page and the heartbeat both take the finish date from the live replay (one projection, not two)",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
