// Campaign Planner, budget over time: put in a budget (per month, or one pot
// to spread) and see what it adds up to month by month: what we spend, the
// contacts and emails it carries, the replies it should bring, with running
// totals. The fleet is sized exactly like the per-month view (fleetContext),
// and every month's sending is measured with the tick engine, so month 1
// carries the warm-up ramp instead of a flat average.
//
// Month 0 is the stretch before the first email: domains are bought (a year
// up front) and the inboxes' seats run through the warm-up window. A domain
// renewal lands in the month a year after purchase, if the horizon reaches it.

import { AVG_DAYS_PER_MONTH } from "@/lib/deliverability/costs";
import { fleetContext, type BudgetInput, type BudgetLimit, type FleetContext } from "./budget";

/** Longest horizon the view offers. */
export const MAX_TIMELINE_MONTHS = 12;
/** Total mode: the pot spread over each of these, side by side. */
export const SPREAD_OPTIONS_MONTHS = [1, 2, 3, 6, 12];

export type BudgetMode = "monthly" | "total";

export interface TimelineInput extends Omit<BudgetInput, "monthlyBudgetUsd"> {
  budgetMode: BudgetMode;
  /** Per month (monthly mode) or the whole pot (total mode). */
  amountUsd: number;
  /** Months of sending to show; in total mode, also the months the pot is spread over. */
  months: number;
  /** Days of seats paid before the first email (the warm-up window). */
  warmingDays: number;
  /** Repliers ÷ contacts emailed, in %. null = no reply projection. */
  replyRatePct: number | null;
  /** Positive replies ÷ replies, in %. */
  positiveRatePct: number | null;
}

export interface TimelineRow {
  /** 0 = before the first email (domains bought, inboxes warming). */
  month: number;
  spend: number;
  /** Full sequences' worth (emails ÷ emails per contact), as in the per-month view. */
  contacts: number;
  emails: number;
  replies: number | null;
  positives: number | null;
  /** This month includes a domain renewal. */
  renewal: boolean;
  spendToDate: number;
  contactsToDate: number;
  positivesToDate: number | null;
}

export interface TimelinePlan {
  mode: BudgetMode;
  months: number;
  /** What the budget allows across the horizon (monthly: amount × months, setup not included). */
  budgetTotal: number;
  affordableInboxes: number;
  inboxes: number;
  domains: number;
  limitedBy: BudgetLimit;
  rows: TimelineRow[];
  totalSpend: number;
  totalContacts: number;
  totalEmails: number;
  totalReplies: number | null;
  totalPositives: number | null;
  /** Budget not spent (monthly: against months 1..N; total: against the whole pot). */
  leftover: number;
  costPerContact: number | null;
  costPerPositive: number | null;
  /** Month 0: domains + warm-up seats. */
  setupCost: number;
}

/** Plans for several horizons at once; they share one fleet context (and its run cache). */
export function timelinePlans(
  x: TimelineInput,
  horizons: number[],
  ctx: FleetContext = fleetContext({ ...x, monthlyBudgetUsd: x.amountUsd }),
): TimelinePlan[] {
  const S = ctx.S;
  const amount = Math.max(0, x.amountUsd || 0);
  const warmMonths = Math.max(0, x.warmingDays || 0) / AVG_DAYS_PER_MONTH;
  const reply = x.replyRatePct != null && x.replyRatePct >= 0 ? x.replyRatePct / 100 : null;
  const positive = x.positiveRatePct != null && x.positiveRatePct >= 0 ? x.positiveRatePct / 100 : null;
  // Domains are bought warmMonths before month 1 and renew a year later.
  const renewalMonth = Math.floor(12 - warmMonths) + 1;

  return horizons.map((h) => {
    const N = Math.min(MAX_TIMELINE_MONTHS, Math.max(1, Math.floor(h) || 1));
    let aff: number;
    if (x.budgetMode === "monthly") {
      aff = ctx.affordableMonthly(amount);
    } else {
      // The whole pot must cover the domains (each year started), the seats
      // from purchase to the end, and (when we source) the contacts at their
      // full-use ceiling so it never under-reserves.
      const years = Math.ceil((N + warmMonths) / 12);
      const totalCost = (inb: number) =>
        ctx.domainsFor(inb) * x.domainUsdPerYear * years +
        inb * x.seatUsdPerMonth * (N + warmMonths) +
        (x.weSource ? ctx.fullUseContacts(inb) * N * x.sourcingUsdPerContact : 0);
      aff = 0;
      if (!ctx.paused) while (aff < ctx.maxInboxes && totalCost(aff + 1) <= amount) aff++;
    }
    const inboxes = ctx.worthBuying(aff);
    const domains = ctx.domainsFor(inboxes);
    const sent = inboxes > 0 ? ctx.measure(inboxes, N) : [];

    const setupCost = domains * x.domainUsdPerYear + inboxes * x.seatUsdPerMonth * warmMonths;
    const rows: TimelineRow[] = [
      {
        month: 0,
        spend: setupCost,
        contacts: 0,
        emails: 0,
        replies: reply != null ? 0 : null,
        positives: reply != null && positive != null ? 0 : null,
        renewal: false,
        spendToDate: setupCost,
        contactsToDate: 0,
        positivesToDate: reply != null && positive != null ? 0 : null,
      },
    ];
    for (let m = 1; m <= N; m++) {
      const prev = rows[rows.length - 1];
      const emails = sent[m - 1]?.emails ?? 0;
      const contacts = emails / S;
      const renewal = m === renewalMonth && domains > 0;
      const spend =
        inboxes * x.seatUsdPerMonth +
        (x.weSource ? contacts * x.sourcingUsdPerContact : 0) +
        (renewal ? domains * x.domainUsdPerYear : 0);
      const replies = reply != null ? contacts * reply : null;
      const positives = replies != null && positive != null ? replies * positive : null;
      rows.push({
        month: m,
        spend,
        contacts,
        emails,
        replies,
        positives,
        renewal,
        spendToDate: prev.spendToDate + spend,
        contactsToDate: prev.contactsToDate + contacts,
        positivesToDate:
          positives != null && prev.positivesToDate != null ? prev.positivesToDate + positives : null,
      });
    }

    const last = rows[rows.length - 1];
    const totalEmails = rows.reduce((a, r) => a + r.emails, 0);
    const totalReplies = reply != null ? rows.reduce((a, r) => a + (r.replies ?? 0), 0) : null;
    const totalPositives = last.positivesToDate;
    // A monthly budget is recurring spend (months 1..N); the one-time setup in
    // month 0 is reported beside it. A total budget is the whole pot, setup included.
    const budgetTotal = x.budgetMode === "monthly" ? amount * N : amount;
    const counted = x.budgetMode === "monthly" ? last.spendToDate - setupCost : last.spendToDate;
    return {
      mode: x.budgetMode,
      months: N,
      budgetTotal,
      affordableInboxes: aff,
      inboxes,
      domains,
      limitedBy: ctx.limitFor(inboxes, aff),
      rows,
      totalSpend: last.spendToDate,
      totalContacts: last.contactsToDate,
      totalEmails,
      totalReplies,
      totalPositives,
      leftover: budgetTotal - counted,
      costPerContact: last.contactsToDate > 0 ? last.spendToDate / last.contactsToDate : null,
      costPerPositive: totalPositives != null && totalPositives > 0 ? last.spendToDate / totalPositives : null,
      setupCost,
    };
  });
}

export function timelinePlan(x: TimelineInput): TimelinePlan {
  return timelinePlans(x, [x.months])[0];
}

/** Total mode: the same pot spread over 1, 2, 3, 6 and 12 months, side by side. */
export function spreadComparison(x: TimelineInput, ctx?: FleetContext): TimelinePlan[] {
  return timelinePlans({ ...x, budgetMode: "total" }, SPREAD_OPTIONS_MONTHS, ctx);
}
