// Unit tests for the Campaign Planner math (src/lib/planner/*).
//
// The planner replays the native send dispatcher tick by tick, so these tests
// check the replay obeys the dispatcher's own limits (from src/lib/gmail/ramp.ts),
// that every input combination terminates, that dates are civil and weekday-
// correct, and that the economics and budget numbers add up from the shared
// cost constants. A drift section fails if the cron schedule or the cron's
// constants stop matching what the planner reads.
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
  type SendEvent,
} from "../src/lib/planner/engine";
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
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
