// Civil (calendar) dates for the Campaign Planner: plain "YYYY-MM-DD" strings,
// computed with UTC arithmetic so a result never depends on the runtime's own
// timezone. The planner page renders on the server and again in the browser,
// and both must print the same dates.

import { computeLaunchDate } from "@/lib/billing/schedule";

export type CivilDate = string; // "YYYY-MM-DD"

const CIVIL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

export function parseCivil(s: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!s) return null;
  const match = CIVIL_RE.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

export function isCivil(s: unknown): s is CivilDate {
  return typeof s === "string" && parseCivil(s) !== null;
}

function toUtcMs(s: CivilDate): number {
  const p = parseCivil(s);
  if (!p) throw new Error(`Not a YYYY-MM-DD date: ${s}`);
  return Date.UTC(p.y, p.m - 1, p.d);
}

function fromUtcMs(ms: number): CivilDate {
  const x = new Date(ms);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

export function addDays(s: CivilDate, n: number): CivilDate {
  return fromUtcMs(toUtcMs(s) + n * DAY_MS);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(s: CivilDate): number {
  return new Date(toUtcMs(s)).getUTCDay();
}

export function isWeekend(s: CivilDate): boolean {
  const w = weekday(s);
  return w === 0 || w === 6;
}

/** Same day-of-month `k` months later, clamped to the month's last day. */
export function addMonths(s: CivilDate, k: number): CivilDate {
  const p = parseCivil(s);
  if (!p) throw new Error(`Not a YYYY-MM-DD date: ${s}`);
  const total = p.m - 1 + k;
  const y = p.y + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${pad(m + 1)}-${pad(Math.min(p.d, lastDay))}`;
}

/**
 * Launch day for inboxes bought on `start`: the real quote-schedule rule
 * (computeLaunchDate: start + warm-up days, rolled to the next weekday). A Date
 * built from local parts and read back with local getters gives the same civil
 * answer in every runtime timezone.
 */
export function launchDateFor(start: CivilDate, warmingDays: number): CivilDate {
  const p = parseCivil(start);
  if (!p) throw new Error(`Not a YYYY-MM-DD date: ${start}`);
  const launch = computeLaunchDate(new Date(p.y, p.m - 1, p.d), warmingDays);
  return `${launch.getFullYear()}-${pad(launch.getMonth() + 1)}-${pad(launch.getDate())}`;
}

/** Today's civil date in an IANA timezone (the planner uses the send window's). */
export function todayIn(timeZone: string, now: Date = new Date()): CivilDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
