// Unit tests for the Campaign Planner's "Over time" budget view
// (src/lib/planner/timeline.ts): month-by-month spend, contacts and replies
// for a monthly budget or a pot spread over N months.
//
// Run:  npx tsx scripts/test-planner-timeline.ts

import { GOOGLE_SEAT_USD_PER_MONTH, SENDING_DOMAIN_USD_PER_YEAR, AVG_DAYS_PER_MONTH } from "../src/lib/deliverability/costs";
import { budgetPlan } from "../src/lib/planner/budget";
import {
  MAX_TIMELINE_MONTHS,
  SPREAD_OPTIONS_MONTHS,
  spreadComparison,
  timelinePlan,
  type TimelineInput,
} from "../src/lib/planner/timeline";

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
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const BASE: TimelineInput = {
  budgetMode: "monthly",
  amountUsd: 100,
  months: 6,
  warmingDays: 14,
  replyRatePct: 1.2,
  positiveRatePct: 25,
  waits: [0, 3, 2],
  campaigns: 1,
  strategy: "finish_first",
  newLeadsCap: 20,
  weekdaysOnly: true,
  startHour: 8,
  endHour: 17,
  maxDailyCap: 20,
  inboxesPerDomain: 3,
  weSource: true,
  sourcingUsdPerContact: 0.08,
  seatUsdPerMonth: GOOGLE_SEAT_USD_PER_MONTH,
  domainUsdPerYear: SENDING_DOMAIN_USD_PER_YEAR,
  otherSendsPerDay: 0,
  launchDate: "2026-10-19",
};

console.log("Shape and running totals:");
{
  const p = timelinePlan(BASE);
  ok(p.rows.length === BASE.months + 1 && p.rows[0].month === 0, `month 0 + ${BASE.months} months of rows`);
  ok(p.rows[0].contacts === 0 && p.rows[0].emails === 0, "month 0 (before the first email) sends nothing");
  let spend = 0;
  let contacts = 0;
  let consistent = true;
  for (const r of p.rows) {
    spend += r.spend;
    contacts += r.contacts;
    if (!near(r.spendToDate, spend) || !near(r.contactsToDate, contacts)) consistent = false;
  }
  ok(consistent, "spent-to-date and contacts-to-date are the running sums");
  ok(near(p.totalSpend, spend) && near(p.totalContacts, contacts), "totals equal the last running sums");
  const expectSetup = p.domains * SENDING_DOMAIN_USD_PER_YEAR + p.inboxes * GOOGLE_SEAT_USD_PER_MONTH * (14 / AVG_DAYS_PER_MONTH);
  ok(near(p.setupCost, expectSetup) && near(p.rows[0].spend, expectSetup), `setup = domains (a year up front) + 14 days of seats ($${expectSetup.toFixed(2)})`);
  const r1 = p.rows[1];
  ok(near(r1.spend, p.inboxes * GOOGLE_SEAT_USD_PER_MONTH + r1.contacts * 0.08), "a month = seats + the contacts it sourced");
  ok(r1.replies != null && near(r1.replies, r1.contacts * 0.012) && r1.positives != null && near(r1.positives, r1.contacts * 0.012 * 0.25), "replies = contacts × 1.2%; positives = replies × 25%");
}

console.log("Agrees with the per-month view:");
{
  const p = timelinePlan(BASE);
  const m = budgetPlan({ ...BASE, monthlyBudgetUsd: BASE.amountUsd });
  ok(p.inboxes === m.inboxes && p.domains === m.domains, `same fleet as the per-month view (${p.inboxes} inboxes, ${p.domains} domains)`);
  ok(near(p.rows[1].contacts, m.contactsMonth1) && near(p.rows[3].contacts, m.contactsPerMonth), "month 1 and month 3 match the per-month view's month 1 and steady state");
  ok(p.limitedBy === m.limitedBy, `same limit (${p.limitedBy})`);
}

console.log("Budget is respected:");
{
  for (const months of [1, 3, 6, 11]) {
    const p = timelinePlan({ ...BASE, strategy: "reach_first", weSource: false, months });
    ok(p.leftover >= -1e-9, `monthly $100 for ${months} mo: recurring spend fits (left $${p.leftover.toFixed(2)}; setup $${p.setupCost.toFixed(2)} shown apart)`);
  }
  for (const p of spreadComparison({ ...BASE, budgetMode: "total", amountUsd: 1000, strategy: "reach_first", weSource: false })) {
    ok(p.totalSpend <= 1000 + 1e-9, `$1,000 pot over ${p.months} mo: spends $${p.totalSpend.toFixed(2)} (setup included)`);
  }
  const sourced = timelinePlan({ ...BASE, budgetMode: "total", amountUsd: 1000, months: 12, strategy: "reach_first" });
  ok(sourced.totalSpend <= 1000 + 1e-9, `$1,000 pot over 12 mo, buying contacts too: $${sourced.totalSpend.toFixed(2)}`);
}

console.log("Ramp, renewals, limits:");
{
  const cold = timelinePlan({ ...BASE, strategy: "reach_first", weSource: false, months: 3 });
  ok(cold.rows[1].contacts < cold.rows[3].contacts, `month 1 (warming) carries fewer contacts than month 3 (${cold.rows[1].contacts.toFixed(0)} < ${cold.rows[3].contacts.toFixed(0)})`);
  const year = timelinePlan({ ...BASE, months: 12 });
  ok(year.rows[12].renewal && !year.rows.slice(1, 12).some((r) => r.renewal), "domains renew in month 12 (bought 14 days before month 1)");
  ok(near(year.rows[12].spend - year.rows[11].spend, year.domains * SENDING_DOMAIN_USD_PER_YEAR, year.rows[12].contacts * 0.08 + 1), "the renewal month carries the domains' fee");
  const half = timelinePlan({ ...BASE, months: 6 });
  ok(!half.rows.some((r) => r.renewal), "no renewal inside 6 months");
  const paused = timelinePlan({ ...BASE, newLeadsCap: 0 });
  ok(paused.inboxes === 0 && paused.totalSpend === 0 && paused.limitedBy === "paused", "cap 0 → nothing bought, nothing spent");
  const noRates = timelinePlan({ ...BASE, replyRatePct: null });
  ok(noRates.totalReplies === null && noRates.totalPositives === null && noRates.costPerPositive === null, "no reply rate → no reply projection");
  const clamped = timelinePlan({ ...BASE, months: 99 });
  ok(clamped.months === MAX_TIMELINE_MONTHS && clamped.rows.length === MAX_TIMELINE_MONTHS + 1, `horizon clamps to ${MAX_TIMELINE_MONTHS} months`);
}

console.log("Spreading one pot:");
{
  const spread = spreadComparison({ ...BASE, budgetMode: "total", amountUsd: 1000, strategy: "reach_first", weSource: false });
  ok(spread.map((p) => p.months).join(",") === SPREAD_OPTIONS_MONTHS.join(","), `one plan per option (${SPREAD_OPTIONS_MONTHS.join(", ")} months)`);
  ok(spread[0].inboxes >= spread[spread.length - 1].inboxes, "a shorter spread buys a bigger fleet");
  const best = spread.reduce((a, b) => (b.totalContacts > a.totalContacts ? b : a));
  ok(best.months > 1, `a 1-month burst is not the best use of a pot (most contacts: ${best.months} mo)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
