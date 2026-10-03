// The Campaign Planner's inputs, and their round-trip through the page URL so a
// plan is a shareable link. Defaults come from the live constants (never
// retyped), and only values that differ from a default are written to the URL,
// so links stay short and pick up a changed constant automatically.

import {
  DEFAULT_DAILY_NEW_LEADS_CAP,
  DEFAULT_MAX_DAILY_CAP,
  DEFAULT_SENDING_STRATEGY,
  ABSOLUTE_MAX_DAILY_CAP,
  SEND_WINDOW,
} from "@/lib/gmail/ramp";
import { DEFAULT_WARMING_DAYS } from "@/lib/billing/schedule";
import { MAX_INBOXES_PER_DOMAIN } from "@/lib/deliverability/provisioning";
import { DRAIN_DAYS } from "@/lib/deliverability/lifecycle";
import { GOOGLE_SEAT_USD_PER_MONTH, SENDING_DOMAIN_USD_PER_YEAR } from "@/lib/deliverability/costs";
import { graphToSteps, starterGraph } from "@/lib/flow/graph";
import { isCivil, type CivilDate } from "@/lib/planner/dates";
import { MAX_PLANNED_DOMAINS, MAX_SEQUENCE_EMAILS } from "@/lib/planner/engine";
import { MAX_TIMELINE_MONTHS, type BudgetMode } from "@/lib/planner/timeline";
import {
  PLANNER_DEFAULT_SOURCING_USD,
  STRIPE_CARD_FEE_FIXED_USD,
  STRIPE_CARD_FEE_PCT,
  type ContactsMode,
  type DomainBasis,
} from "@/lib/planner/economics";
import type { SendingStrategy } from "@/types/app";

export type PlannerTab = "campaign" | "budget";
export type BudgetView = "monthly" | "timeline";

export interface PlannerState {
  tab: PlannerTab;
  // Contacts and sequence
  contactsMode: ContactsMode;
  listSize: number;
  sendablePct: number;
  /** wait_days per email; index 0 is the first email (always 0 here). */
  waits: number[];
  // Sending infrastructure and timeline
  domains: number;
  inboxesPerDomain: number;
  startDate: CivilDate;
  warmingDays: number;
  // Our costs
  sourcingUsd: number;
  seatUsd: number;
  domainUsd: number;
  domainBasis: DomainBasis;
  otherMonthlyUsd: number;
  // What the client pays
  retainerUsd: number;
  setupUsd: number;
  sourcingPriceUsd: number;
  chargesOverride: number | null;
  feePct: number;
  feeFixedUsd: number;
  // Outcomes (null = use the org's history)
  replyRatePct: number | null;
  positiveRatePct: number | null;
  // Sending rules (Advanced)
  strategy: SendingStrategy;
  newLeadsCap: number;
  maxDailyCap: number;
  startHour: number;
  endHour: number;
  weekdaysOnly: boolean;
  domainDailyCap: number | null;
  otherSendsPerDay: number;
  startWarmed: boolean;
  drainDays: number;
  // Budget tab
  /** "Per month" (steady state + ladder) or "Over time" (month by month). */
  budgetView: BudgetView;
  budgetUsd: number;
  campaigns: number;
  /** Over time: a monthly budget, or one total to spread. */
  budgetMode: BudgetMode;
  totalBudgetUsd: number;
  horizonMonths: number;
  // "Finish by" solver target
  finishBy: CivilDate | null;
}

/** The starter template's waits, the same sequence a new native campaign opens with. */
export function starterWaits(): number[] {
  return graphToSteps(starterGraph()).map((s) => s.wait_days);
}

export function plannerDefaults(today: CivilDate): PlannerState {
  return {
    tab: "campaign",
    contactsMode: "we_source",
    listSize: 1000,
    sendablePct: 100,
    waits: starterWaits(),
    domains: 1,
    inboxesPerDomain: MAX_INBOXES_PER_DOMAIN,
    startDate: today,
    warmingDays: DEFAULT_WARMING_DAYS,
    sourcingUsd: PLANNER_DEFAULT_SOURCING_USD,
    seatUsd: GOOGLE_SEAT_USD_PER_MONTH,
    domainUsd: SENDING_DOMAIN_USD_PER_YEAR,
    domainBasis: "dedicated",
    otherMonthlyUsd: 0,
    retainerUsd: 0,
    setupUsd: 0,
    sourcingPriceUsd: 0,
    chargesOverride: null,
    feePct: STRIPE_CARD_FEE_PCT,
    feeFixedUsd: STRIPE_CARD_FEE_FIXED_USD,
    replyRatePct: null,
    positiveRatePct: null,
    strategy: DEFAULT_SENDING_STRATEGY,
    newLeadsCap: DEFAULT_DAILY_NEW_LEADS_CAP,
    maxDailyCap: DEFAULT_MAX_DAILY_CAP,
    startHour: SEND_WINDOW.startHour,
    endHour: SEND_WINDOW.endHour,
    weekdaysOnly: SEND_WINDOW.weekdaysOnly,
    domainDailyCap: null,
    otherSendsPerDay: 0,
    startWarmed: false,
    drainDays: DRAIN_DAYS,
    budgetView: "monthly",
    budgetUsd: 100,
    campaigns: 1,
    budgetMode: "monthly",
    totalBudgetUsd: 1000,
    horizonMonths: 6,
    finishBy: null,
  };
}

/** The sequence with `n` emails: extra emails reuse the last gap (or 3 days); waits[0] stays 0. */
export function withEmailCount(waits: number[], n: number | null): number[] {
  const count = Math.max(1, Math.min(MAX_SEQUENCE_EMAILS, Math.floor(n ?? 1)));
  const gaps = waits.slice(1);
  const uniform = gaps.length > 0 && gaps.every((g) => g === gaps[0]) ? gaps[0] : null;
  const fill = uniform ?? gaps[gaps.length - 1] ?? 3;
  const next = waits.slice(0, count);
  while (next.length < count) next.push(fill);
  next[0] = 0;
  return next;
}

// ── URL round-trip ─────────────────────────────────────────────────────────
// One short key per field. Numbers are clamped on the way in, so a hand-edited
// or stale link can never feed the engine something it can't run.

type Num = { key: string; min: number; max: number; int?: boolean };
const NUMS: Partial<Record<keyof PlannerState, Num>> = {
  listSize: { key: "n", min: 0, max: 1_000_000, int: true },
  sendablePct: { key: "sp", min: 0, max: 100 },
  domains: { key: "d", min: 1, max: MAX_PLANNED_DOMAINS, int: true },
  inboxesPerDomain: { key: "ipd", min: 1, max: MAX_INBOXES_PER_DOMAIN, int: true },
  warmingDays: { key: "wd", min: 0, max: 365, int: true },
  sourcingUsd: { key: "sc", min: 0, max: 100 },
  seatUsd: { key: "seat", min: 0, max: 1000 },
  domainUsd: { key: "dom", min: 0, max: 1000 },
  otherMonthlyUsd: { key: "om", min: 0, max: 1_000_000 },
  retainerUsd: { key: "rt", min: 0, max: 10_000_000 },
  setupUsd: { key: "su", min: 0, max: 10_000_000 },
  sourcingPriceUsd: { key: "spc", min: 0, max: 1000 },
  chargesOverride: { key: "ch", min: 0, max: 120, int: true },
  feePct: { key: "fp", min: 0, max: 100 },
  feeFixedUsd: { key: "ff", min: 0, max: 100 },
  replyRatePct: { key: "rr", min: 0, max: 100 },
  positiveRatePct: { key: "pr", min: 0, max: 100 },
  newLeadsCap: { key: "cap", min: 0, max: 1000, int: true },
  maxDailyCap: { key: "mx", min: 1, max: ABSOLUTE_MAX_DAILY_CAP, int: true },
  startHour: { key: "sh", min: 0, max: 23, int: true },
  endHour: { key: "eh", min: 1, max: 24, int: true },
  domainDailyCap: { key: "dc", min: 1, max: 1000, int: true },
  otherSendsPerDay: { key: "os", min: 0, max: 100_000, int: true },
  drainDays: { key: "dr", min: 0, max: 365, int: true },
  budgetUsd: { key: "b", min: 0, max: 1_000_000 },
  campaigns: { key: "nc", min: 1, max: 100, int: true },
  totalBudgetUsd: { key: "tb", min: 0, max: 10_000_000 },
  horizonMonths: { key: "hm", min: 1, max: MAX_TIMELINE_MONTHS, int: true },
};
const NULLABLE = new Set<keyof PlannerState>(["chargesOverride", "replyRatePct", "positiveRatePct", "domainDailyCap"]);

export type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function clampNum(raw: string, spec: Num): number | null {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) return null;
  const v = Math.min(spec.max, Math.max(spec.min, n));
  return spec.int ? Math.floor(v) : v;
}

export function parsePlannerState(params: RawParams, defaults: PlannerState): PlannerState {
  const s: PlannerState = { ...defaults, waits: [...defaults.waits] };
  const rec = s as unknown as Record<string, unknown>;
  for (const [field, spec] of Object.entries(NUMS) as [keyof PlannerState, Num][]) {
    const raw = first(params[spec.key]);
    if (raw == null) continue;
    if (raw === "none" && NULLABLE.has(field)) {
      rec[field] = null;
      continue;
    }
    const v = clampNum(raw, spec);
    if (v != null) rec[field] = v;
  }
  if (s.endHour <= s.startHour) s.endHour = Math.min(24, s.startHour + 1);

  const tab = first(params.t);
  if (tab === "budget" || tab === "campaign") s.tab = tab;
  const bv = first(params.bv);
  if (bv === "time") s.budgetView = "timeline";
  if (bv === "month") s.budgetView = "monthly";
  const bm = first(params.bm);
  if (bm === "total") s.budgetMode = "total";
  if (bm === "month") s.budgetMode = "monthly";
  const cm = first(params.cm);
  if (cm === "client") s.contactsMode = "client_supplies";
  if (cm === "we") s.contactsMode = "we_source";
  const st = first(params.st);
  if (st === "reach") s.strategy = "reach_first";
  if (st === "finish") s.strategy = "finish_first";
  const db = first(params.db);
  if (db === "shared") s.domainBasis = "shared";
  if (db === "dedicated") s.domainBasis = "dedicated";
  const wk = first(params.wk);
  if (wk === "0") s.weekdaysOnly = false;
  if (wk === "1") s.weekdaysOnly = true;
  if (first(params.warm) === "1") s.startWarmed = true;
  const sd = first(params.sd);
  if (isCivil(sd)) s.startDate = sd;
  const fb = first(params.fb);
  if (isCivil(fb)) s.finishBy = fb;
  const w = first(params.w);
  if (w) {
    const waits = w
      .split(".")
      .slice(0, MAX_SEQUENCE_EMAILS)
      .map((x) => Math.min(365, Math.max(0, Math.floor(Number(x)))))
      .filter((x) => Number.isFinite(x));
    if (waits.length > 0) s.waits = [0, ...waits.slice(1)];
  }
  return s;
}

export function serializePlannerState(s: PlannerState, defaults: PlannerState): string {
  const q = new URLSearchParams();
  const rec = s as unknown as Record<string, unknown>;
  const def = defaults as unknown as Record<string, unknown>;
  if (s.tab !== defaults.tab) q.set("t", s.tab);
  if (s.budgetView !== defaults.budgetView) q.set("bv", s.budgetView === "timeline" ? "time" : "month");
  if (s.budgetMode !== defaults.budgetMode) q.set("bm", s.budgetMode === "total" ? "total" : "month");
  if (s.contactsMode !== defaults.contactsMode) q.set("cm", s.contactsMode === "client_supplies" ? "client" : "we");
  if (s.strategy !== defaults.strategy) q.set("st", s.strategy === "reach_first" ? "reach" : "finish");
  if (s.domainBasis !== defaults.domainBasis) q.set("db", s.domainBasis);
  if (s.weekdaysOnly !== defaults.weekdaysOnly) q.set("wk", s.weekdaysOnly ? "1" : "0");
  if (s.startWarmed) q.set("warm", "1");
  if (s.startDate !== defaults.startDate) q.set("sd", s.startDate);
  if (s.finishBy) q.set("fb", s.finishBy);
  if (s.waits.join(".") !== defaults.waits.join(".")) q.set("w", s.waits.join("."));
  for (const [field, spec] of Object.entries(NUMS) as [keyof PlannerState, Num][]) {
    const v = rec[field];
    if (v === def[field]) continue;
    q.set(spec.key, v == null ? "none" : String(v));
  }
  return q.toString();
}
