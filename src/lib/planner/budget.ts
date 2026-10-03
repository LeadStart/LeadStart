// Campaign Planner budget view: what a monthly budget buys in domains, inboxes,
// emails and contacts, in month 1 (inboxes ramping) and at steady state.
//
// Two steps. (1) Affordability is closed-form: the most inboxes whose seats,
// domain share and (when we source) contacts fit the budget, with contacts at
// their full-use ceiling so the estimate never under-reserves for them.
// (2) What those inboxes actually deliver is MEASURED with the tick engine on
// an endless list (measureThroughput): ramp, the new-leads cap, Monday
// pile-ups and the dispatcher's per-tick budget all included. Full-use
// arithmetic overstates this by a lot when the cap and capacity are close.
//
// The honest limit is often not money. Under finish_first a campaign starts at
// most its new-leads cap of contacts a day, so past a certain fleet size more
// budget buys capacity nothing uses. The plan stops at the inbox count where
// one more domain adds under 2% more contacts, and says what's left over.
//
// fleetContext() holds the sending side (sizing, saturation, measurement) so
// the per-month view here and the over-time view (timeline.ts) agree.

import { ABSOLUTE_MAX_DAILY_CAP, NATIVE_TICK_MINUTES, SENDS_PER_TICK } from "@/lib/gmail/ramp";
import { AVG_DAYS_PER_MONTH } from "@/lib/deliverability/costs";
import type { SendingStrategy } from "@/types/app";
import type { CivilDate } from "./dates";
import { MAX_PLANNED_DOMAINS, measureThroughput, rampCaps, type MonthThroughput } from "./engine";

/** Months measured; the last one is reported as steady state. */
export const BUDGET_MEASURE_MONTHS = 3;
/** One more domain must add at least this share of contacts to be worth buying. */
const SATURATION_GAIN = 0.02;

export interface BudgetInput {
  monthlyBudgetUsd: number;
  /** The sequence: wait_days per email (its length = emails per contact). */
  waits: number[];
  /** Campaigns sharing this budget; each has its own new-leads cap. */
  campaigns: number;
  strategy: SendingStrategy;
  /** Per campaign. */
  newLeadsCap: number;
  weekdaysOnly: boolean;
  startHour: number;
  endHour: number;
  maxDailyCap: number;
  inboxesPerDomain: number;
  /** true: the budget also buys the contacts; false: the client supplies them. */
  weSource: boolean;
  sourcingUsdPerContact: number;
  seatUsdPerMonth: number;
  domainUsdPerYear: number;
  otherSendsPerDay: number;
  /** Anchors the weekday calendar for the measurement. */
  launchDate: CivilDate;
}

export type BudgetLimit = "budget" | "new_leads_cap" | "platform" | "paused";

export interface BudgetPlan {
  budget: number;
  /** Inboxes the budget could pay for. */
  affordableInboxes: number;
  /** Inboxes worth buying: affordable, or fewer when contacts can't fill them. */
  inboxes: number;
  domains: number;
  /** Monthly run-rate: seats + the domains' yearly fee ÷ 12 + contacts. */
  monthlyCost: number;
  seatsCost: number;
  domainsCost: number;
  sourcingCost: number;
  leftover: number;
  /** Domains are billed a year at a time: the bill at purchase. */
  domainsUpFront: number;
  capacityPerDay: number;
  /** Contacts per month as full sequences' worth (emails ÷ emails per contact). */
  contactsMonth1: number;
  contactsPerMonth: number;
  emailsMonth1: number;
  emailsPerMonth: number;
  emailsPerDay: number;
  utilizationPct: number;
  limitedBy: BudgetLimit;
  /** finish_first: the per-campaign new-leads/day that would put the affordable inboxes to work. */
  suggestedCap: number | null;
  platformCeilingPerDay: number;
  costPerContact: number | null;
  costPer1000Emails: number | null;
}

/** Send days in an average month. */
export function sendDaysPerMonth(weekdaysOnly: boolean): number {
  return AVG_DAYS_PER_MONTH * (weekdaysOnly ? 5 / 7 : 1);
}

/** Emails one fully loaded inbox sends over `days` send days from a cold start. */
export function rampedEmails(days: number, maxDailyCap: number): number {
  const whole = Math.floor(days);
  const caps = rampCaps(whole + 1, maxDailyCap);
  let total = 0;
  for (let d = 0; d < whole; d++) total += caps[d];
  return total + (days - whole) * caps[whole];
}

/** Everything the dispatcher can send in a day, across ALL campaigns. */
export function platformCeilingPerDay(startHour: number, endHour: number): number {
  const ticks = Math.max(0, ((endHour - startHour) * 60) / NATIVE_TICK_MINUTES);
  return SENDS_PER_TICK * ticks;
}

export interface FleetContext {
  /** Emails per contact. */
  S: number;
  ipd: number;
  campaigns: number;
  maxCap: number;
  /** Send days in an average month. */
  sdpm: number;
  paused: boolean;
  /** Contacts the campaigns' new-leads caps allow per month (Infinity under reach_first). */
  capMonthly: number;
  /** What the dispatcher can send per day for us (after other campaigns). */
  ceiling: number;
  /** Sends a day contacts can actually use: caps × sequence length, at most the ceiling. */
  usableSendsPerDay: number;
  maxInboxes: number;
  domainsFor(inb: number): number;
  /** Full-use (upper bound) contacts per month for `inb` inboxes. */
  fullUseContacts(inb: number): number;
  /** Most inboxes a monthly run-rate (seats + domains ÷ 12 + contacts) can pay for. */
  affordableMonthly(budget: number): number;
  /** Inboxes worth buying out of `affordable`: fewer when contacts can't fill them. */
  worthBuying(affordable: number): number;
  /** Why fewer than the affordable inboxes were bought. */
  limitFor(inboxes: number, affordable: number): BudgetLimit;
  /** Measured month-by-month throughput of `inb` inboxes (cached per inbox count). */
  measure(inb: number, months: number): MonthThroughput[];
}

/**
 * The sending side of a budget plan, shared by the per-month and over-time
 * views so both size, saturate and measure a fleet the same way. One context
 * caches every engine run it makes; reuse it across budgets and horizons.
 */
export function fleetContext(x: BudgetInput): FleetContext {
  const S = Math.max(1, x.waits.length);
  const ipd = Math.max(1, Math.floor(x.inboxesPerDomain) || 1);
  const campaigns = Math.max(1, Math.floor(x.campaigns) || 1);
  const maxCap = Math.min(ABSOLUTE_MAX_DAILY_CAP, Math.max(1, Math.floor(x.maxDailyCap) || 1));
  const sdpm = sendDaysPerMonth(x.weekdaysOnly);
  const paused = x.newLeadsCap <= 0;
  const ceiling = Math.max(0, platformCeilingPerDay(x.startHour, x.endHour) - Math.max(0, x.otherSendsPerDay));
  const maxInboxes = MAX_PLANNED_DOMAINS * ipd;

  // Full-use contact ceiling per month: capacity ÷ emails per contact, capped
  // by the campaigns' new-leads caps under finish_first.
  const capMonthly =
    paused ? 0 : x.strategy === "finish_first" ? campaigns * x.newLeadsCap * sdpm : Infinity;
  const fullUseContacts = (inb: number) => Math.min((inb * maxCap * sdpm) / S, capMonthly, (ceiling * sdpm) / S);
  const usableSendsPerDay = Math.min((capMonthly / sdpm) * S, ceiling);
  const domainsFor = (inb: number) => Math.ceil(inb / ipd);
  const monthlyCost = (inb: number) =>
    inb * x.seatUsdPerMonth +
    (domainsFor(inb) * x.domainUsdPerYear) / 12 +
    (x.weSource ? fullUseContacts(inb) * x.sourcingUsdPerContact : 0);
  const affordableMonthly = (budget: number) => {
    if (paused) return 0;
    let inb = 0;
    while (inb < maxInboxes && monthlyCost(inb + 1) <= budget) inb++;
    return inb;
  };

  // One engine run per inbox count, kept at the longest horizon asked for:
  // months 1..m of a longer run are the same months.
  const cache = new Map<number, MonthThroughput[]>();
  const measure = (inb: number, months: number): MonthThroughput[] => {
    const have = cache.get(inb);
    if (have && have.length >= months) return have.slice(0, months);
    const t = measureThroughput(
      {
        contacts: 1,
        waits: x.waits,
        domains: domainsFor(inb),
        inboxesPerDomain: ipd,
        inboxes: inb,
        maxDailyCap: maxCap,
        strategy: x.strategy,
        // Campaigns are pooled: N campaigns at cap C start ≈ one at N×C.
        newLeadsCap: x.newLeadsCap * campaigns,
        weekdaysOnly: x.weekdaysOnly,
        startHour: x.startHour,
        endHour: x.endHour,
        domainDailyCap: null,
        otherSendsPerDay: x.otherSendsPerDay,
        startWarmed: false,
        launchDate: x.launchDate,
      },
      Math.max(months, BUDGET_MEASURE_MONTHS),
    );
    cache.set(inb, t);
    return t.slice(0, months);
  };
  // Contacts are counted as full sequences' worth (emails ÷ emails per contact),
  // not first touches: on an endless list reach_first never gets to follow-ups,
  // so first touches alone would count contacts that never finish.
  const steady = (inb: number) => measure(inb, BUDGET_MEASURE_MONTHS)[BUDGET_MEASURE_MONTHS - 1].emails / S;

  // Where contacts stop filling more inboxes (budget-independent): start at the
  // full-use fit and add a domain at a time until the gain drops under 2%.
  let saturation: number | null = null;
  const saturationInboxes = (): number => {
    if (saturation != null) return saturation;
    let inb = Math.max(1, Math.min(maxInboxes, Math.ceil(usableSendsPerDay / maxCap)));
    let cur = steady(inb);
    while (inb + ipd <= maxInboxes) {
      const next = steady(inb + ipd);
      if (next < cur * (1 + SATURATION_GAIN)) break;
      inb += ipd;
      cur = next;
    }
    saturation = inb;
    return inb;
  };
  const worthBuying = (aff: number) =>
    aff > 0 && aff * maxCap > usableSendsPerDay ? Math.min(aff, saturationInboxes()) : aff;
  const limitFor = (inboxes: number, aff: number): BudgetLimit => {
    if (paused) return "paused";
    if (inboxes >= aff) return "budget";
    const capPerDaySends = x.strategy === "finish_first" ? campaigns * x.newLeadsCap * S : Infinity;
    return capPerDaySends < ceiling ? "new_leads_cap" : "platform";
  };

  return {
    S,
    ipd,
    campaigns,
    maxCap,
    sdpm,
    paused,
    capMonthly,
    ceiling,
    usableSendsPerDay,
    maxInboxes,
    domainsFor,
    fullUseContacts,
    affordableMonthly,
    worthBuying,
    limitFor,
    measure,
  };
}

/** Plans for several budgets at once; they share one fleet context (and its run cache). */
export function budgetPlans(x: BudgetInput, budgets: number[], ctx: FleetContext = fleetContext(x)): BudgetPlan[] {
  const { S, maxCap, campaigns } = ctx;
  return budgets.map((rawBudget) => {
    const budget = Math.max(0, rawBudget || 0);
    const aff = ctx.affordableMonthly(budget);
    const inboxes = ctx.worthBuying(aff);
    const t = inboxes > 0 ? ctx.measure(inboxes, BUDGET_MEASURE_MONTHS) : null;
    const m1 = t ? t[0] : { firstTouches: 0, emails: 0, sendDays: 0 };
    const ms = t ? t[BUDGET_MEASURE_MONTHS - 1] : { firstTouches: 0, emails: 0, sendDays: 0 };
    const contactsMonth1 = m1.emails / S;
    const contactsPerMonth = ms.emails / S;
    const domains = ctx.domainsFor(inboxes);
    const seatsCost = inboxes * x.seatUsdPerMonth;
    const domainsCost = (domains * x.domainUsdPerYear) / 12;
    const sourcingCost = x.weSource ? contactsPerMonth * x.sourcingUsdPerContact : 0;
    const monthlyCost = seatsCost + domainsCost + sourcingCost;
    const capacityPerDay = inboxes * maxCap;
    const emailsPerDay = ms.sendDays > 0 ? ms.emails / ms.sendDays : 0;

    return {
      budget,
      affordableInboxes: aff,
      inboxes,
      domains,
      monthlyCost,
      seatsCost,
      domainsCost,
      sourcingCost,
      leftover: budget - monthlyCost,
      domainsUpFront: domains * x.domainUsdPerYear,
      capacityPerDay,
      contactsMonth1,
      contactsPerMonth,
      emailsMonth1: m1.emails,
      emailsPerMonth: ms.emails,
      emailsPerDay,
      utilizationPct: capacityPerDay > 0 ? (emailsPerDay / capacityPerDay) * 100 : 0,
      limitedBy: ctx.limitFor(inboxes, aff),
      suggestedCap:
        x.strategy === "finish_first" && aff > 0 ? Math.ceil((aff * maxCap) / S / campaigns) : null,
      platformCeilingPerDay: ctx.ceiling,
      costPerContact: contactsPerMonth > 0 ? monthlyCost / contactsPerMonth : null,
      costPer1000Emails: ms.emails > 0 ? (monthlyCost / ms.emails) * 1000 : null,
    };
  });
}

export function budgetPlan(x: BudgetInput): BudgetPlan {
  return budgetPlans(x, [x.monthlyBudgetUsd])[0];
}

export const BUDGET_LADDER_USD = [100, 200, 300, 500, 1000];

/** The ladder table: each standard budget, plus the custom one if it isn't already there. */
export function budgetLadder(x: BudgetInput): BudgetPlan[] {
  const budgets = [...BUDGET_LADDER_USD];
  if (x.monthlyBudgetUsd > 0 && !budgets.includes(x.monthlyBudgetUsd)) budgets.push(x.monthlyBudgetUsd);
  budgets.sort((a, b) => a - b);
  return budgetPlans(x, budgets);
}
