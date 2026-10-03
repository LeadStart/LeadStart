// Campaign Planner economics: what a planned campaign costs us, what it bills,
// our margin, and the replies it should produce. Pure: it reads the engine's
// SimResult plus the cost, price and outcome inputs, and every line carries
// the formula that produced it so the page can show its work.

import { AVG_DAYS_PER_MONTH } from "@/lib/deliverability/costs";
import { MV_CREDIT_COST_USD } from "@/lib/apify/pricing";
import { VERIFICATION_TTL_DAYS } from "@/lib/millionverifier/policy";
import { formatInt, formatNumber, formatUsd } from "@/lib/format";
import { addDays, addMonths, daysBetween, type CivilDate } from "./dates";
import type { SimResult } from "./engine";

/**
 * Default sourcing cost per sendable contact. Measured once: a Dallas Maps run
 * (n=12, ~33% verified-email yield, Perplexity naming), per verified owner
 * personal email. Owner's pick 2026-10-03; a single small sample, so the UI
 * labels it as such.
 */
export const PLANNER_DEFAULT_SOURCING_USD = 0.08;

/** Stripe standard US domestic card rate (stripe.com/pricing, checked 2026-10-03). */
export const STRIPE_CARD_FEE_PCT = 2.9;
export const STRIPE_CARD_FEE_FIXED_USD = 0.3;

export type ContactsMode = "we_source" | "client_supplies";
export type DomainBasis = "dedicated" | "shared";

export interface CostInputs {
  /** The day domains and inboxes are bought (and contacts sourced). */
  startDate: CivilDate;
  contactsMode: ContactsMode;
  /** Contacts on the list. */
  listSize: number;
  /** Client lists only: the share that verifies as sendable, in %. */
  sendablePct: number;
  /** We source: our cost per sendable contact. */
  sourcingUsdPerContact: number;
  seatUsdPerMonth: number;
  domainUsdPerYear: number;
  /** "dedicated" = bought for this campaign (full year started); "shared" = reused (daily share). */
  domainBasis: DomainBasis;
  /** Days inboxes stay up after the last send to catch replies. */
  drainDays: number;
  otherMonthlyUsd: number;
}

export interface PricingInputs {
  monthlyRetainerUsd: number;
  setupFeeUsd: number;
  sourcingPriceUsdPerContact: number;
  /** null = count billing dates from launch through the last send. */
  monthlyChargesOverride: number | null;
  paymentFeePct: number;
  paymentFeeFixedUsd: number;
}

export interface OutcomeInputs {
  /** Repliers ÷ contacts emailed, in %. null = no projection. */
  replyRatePct: number | null;
  /** Positive replies ÷ replies, in %. */
  positiveRatePct: number | null;
}

export interface LineItem {
  key: string;
  label: string;
  amount: number;
  formula: string;
}

export interface Economics {
  costs: LineItem[];
  totalCost: number;
  revenue: LineItem[];
  totalRevenue: number;
  margin: number;
  marginPct: number | null;
  marginPerMonth: number | null;
  /** Days the inboxes exist: start date → last send + drain. */
  seatDays: number;
  seatMonths: number;
  monthlyCharges: number;
  monthlyChargesAuto: number;
  costPerContact: number | null;
  costPerEmail: number | null;
  /** Retainer at which margin is exactly zero (null with no monthly charges). */
  breakevenMonthly: number | null;
  outcomes: {
    replies: number;
    positives: number | null;
    costPerPositive: number | null;
    pricePerPositive: number | null;
  } | null;
}

/** Contacts the sequence actually runs on (a client list loses its invalid addresses). */
export function sequencedContacts(mode: ContactsMode, listSize: number, sendablePct: number): number {
  const n = Math.max(0, Math.floor(listSize));
  if (mode === "we_source") return n;
  const pct = Math.min(100, Math.max(0, sendablePct));
  return Math.floor((n * pct) / 100);
}

/** Monthly charges on billing dates from launch (the first lands on launch day) through `last`. */
export function monthlyChargeCount(launch: CivilDate, last: CivilDate): number {
  let k = 0;
  while (k < 600 && addMonths(launch, k) <= last) k++;
  return Math.max(1, k);
}

export function campaignEconomics(
  sim: SimResult,
  cost: CostInputs,
  price: PricingInputs,
  outcome: OutcomeInputs,
): Economics {
  const inboxes = sim.inboxes;
  const domains = sim.input.domains;
  const contacts = sim.firstTouches || sim.input.contacts;
  const lastSend = sim.lastSendDate ?? sim.launchDate;
  const seatDays = Math.max(1, daysBetween(cost.startDate, addDays(lastSend, Math.max(0, cost.drainDays))));
  const seatMonths = seatDays / AVG_DAYS_PER_MONTH;
  const usd = (n: number) => formatUsd(n, { cents: true });
  const rate = (n: number) => formatUsd(n, { precise: true });
  const count = (n: number, one: string, many = `${one}s`) => `${formatInt(n)} ${n === 1 ? one : many}`;

  // ── What it costs us ──
  const costs: LineItem[] = [];
  if (cost.contactsMode === "we_source") {
    costs.push({
      key: "sourcing",
      label: "Contact sourcing",
      amount: cost.listSize * cost.sourcingUsdPerContact,
      formula: `${count(cost.listSize, "contact")} × ${rate(cost.sourcingUsdPerContact)}`,
    });
    // Sourced contacts are verified when sourced; a first touch more than
    // VERIFICATION_TTL_DAYS later is verified again before it sends.
    const stale = addDays(cost.startDate, VERIFICATION_TTL_DAYS);
    let recheck = 0;
    for (const d of sim.days) if (d.date > stale) recheck += d.firstTouches;
    if (recheck > 0) {
      costs.push({
        key: "reverify",
        label: "Re-verification",
        amount: recheck * MV_CREDIT_COST_USD,
        formula: `${count(recheck, "contact")} first emailed more than ${VERIFICATION_TTL_DAYS} days after sourcing × ${rate(MV_CREDIT_COST_USD)}`,
      });
    }
  } else {
    costs.push({
      key: "verify",
      label: "Verification",
      amount: cost.listSize * MV_CREDIT_COST_USD,
      formula: `${count(cost.listSize, "address", "addresses")} × ${rate(MV_CREDIT_COST_USD)} (each is checked before its first email)`,
    });
  }
  costs.push({
    key: "seats",
    label: "Inbox seats",
    amount: inboxes * cost.seatUsdPerMonth * seatMonths,
    formula: `${count(inboxes, "inbox", "inboxes")} × ${usd(cost.seatUsdPerMonth)}/mo × ${formatNumber(seatMonths, 2)} mo (${formatInt(seatDays)} days: start to last send + ${cost.drainDays}-day reply window)`,
  });
  const domainYears = cost.domainBasis === "dedicated" ? Math.ceil(seatDays / 365) : seatDays / 365;
  costs.push({
    key: "domains",
    label: "Domains",
    amount: domains * cost.domainUsdPerYear * domainYears,
    formula:
      cost.domainBasis === "dedicated"
        ? `${count(domains, "domain")} × ${usd(cost.domainUsdPerYear)}/yr × ${domainYears} yr (bought for this campaign)`
        : `${count(domains, "domain")} × ${usd(cost.domainUsdPerYear)}/yr × ${formatNumber(domainYears, 2)} yr (reused: this campaign's share)`,
  });
  if (cost.otherMonthlyUsd > 0) {
    costs.push({
      key: "other",
      label: "Other monthly costs",
      amount: cost.otherMonthlyUsd * seatMonths,
      formula: `${usd(cost.otherMonthlyUsd)}/mo × ${formatNumber(seatMonths, 2)} mo`,
    });
  }

  // ── What it bills ──
  const monthlyChargesAuto = monthlyChargeCount(sim.launchDate, lastSend);
  const monthlyCharges =
    price.monthlyChargesOverride != null && price.monthlyChargesOverride >= 0
      ? Math.floor(price.monthlyChargesOverride)
      : monthlyChargesAuto;
  const sourcingCharge = cost.listSize * price.sourcingPriceUsdPerContact;
  const revenue: LineItem[] = [];
  if (price.setupFeeUsd > 0) {
    revenue.push({ key: "setup", label: "Setup fee", amount: price.setupFeeUsd, formula: "One time, at signing" });
  }
  if (sourcingCharge > 0) {
    revenue.push({
      key: "sourcing",
      label: "Contact sourcing",
      amount: sourcingCharge,
      formula: `${count(cost.listSize, "contact")} × ${rate(price.sourcingPriceUsdPerContact)}, at signing`,
    });
  }
  revenue.push({
    key: "retainer",
    label: "Monthly retainer",
    amount: price.monthlyRetainerUsd * monthlyCharges,
    formula: `${usd(price.monthlyRetainerUsd)} × ${monthlyCharges} charge${monthlyCharges === 1 ? "" : "s"}${
      price.monthlyChargesOverride == null ? " (launch day, then monthly through the last send)" : ""
    }`,
  });
  const totalRevenue = revenue.reduce((a, r) => a + r.amount, 0);

  // Payment processing rides on what we bill: a share of the money plus a
  // fixed fee per charge (each monthly charge, plus one at signing).
  const upfront = price.setupFeeUsd + sourcingCharge;
  const chargeCount = (price.monthlyRetainerUsd > 0 ? monthlyCharges : 0) + (upfront > 0 ? 1 : 0);
  const pct = Math.max(0, price.paymentFeePct) / 100;
  const fees = totalRevenue * pct + chargeCount * Math.max(0, price.paymentFeeFixedUsd);
  if (fees > 0) {
    costs.push({
      key: "fees",
      label: "Payment processing",
      amount: fees,
      formula: `${formatNumber(price.paymentFeePct, 2)}% of ${usd(totalRevenue)} + ${usd(price.paymentFeeFixedUsd)} × ${chargeCount} charge${chargeCount === 1 ? "" : "s"}`,
    });
  }
  const totalCost = costs.reduce((a, c) => a + c.amount, 0);
  const margin = totalRevenue - totalCost;

  // Breakeven retainer R: (upfront + R·n)(1 − pct) − fixed·charges − otherCosts = 0.
  const nonFeeCost = totalCost - fees;
  const n = monthlyCharges;
  const fixedTotal = ((upfront > 0 ? 1 : 0) + n) * Math.max(0, price.paymentFeeFixedUsd);
  const breakevenMonthly =
    n > 0 && pct < 1 ? Math.max(0, ((nonFeeCost + fixedTotal) / (1 - pct) - upfront) / n) : null;

  let outcomes: Economics["outcomes"] = null;
  if (outcome.replyRatePct != null && outcome.replyRatePct >= 0) {
    const replies = (contacts * outcome.replyRatePct) / 100;
    const positives =
      outcome.positiveRatePct != null && outcome.positiveRatePct >= 0
        ? (replies * outcome.positiveRatePct) / 100
        : null;
    outcomes = {
      replies,
      positives,
      costPerPositive: positives && positives > 0 ? totalCost / positives : null,
      pricePerPositive: positives && positives > 0 ? totalRevenue / positives : null,
    };
  }

  return {
    costs,
    totalCost,
    revenue,
    totalRevenue,
    margin,
    marginPct: totalRevenue > 0 ? (margin / totalRevenue) * 100 : null,
    marginPerMonth: monthlyCharges > 0 ? margin / monthlyCharges : null,
    seatDays,
    seatMonths,
    monthlyCharges,
    monthlyChargesAuto,
    costPerContact: contacts > 0 ? totalCost / contacts : null,
    costPerEmail: sim.totalSends > 0 ? totalCost / sim.totalSends : null,
    breakevenMonthly,
    outcomes,
  };
}
