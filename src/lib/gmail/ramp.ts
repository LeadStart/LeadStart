// Pure send-pacing math for the native email channel. "Ramp as data": a
// brand-new inbox starts at a low daily cap and steps up weekly, computed
// from ramp_started_at + max_daily_cap on the mailbox row. No vendor warmup
// product, no state machine — just arithmetic the worker calls each tick.
//
// Owner-chosen defaults (2026-07-02): steady state 20 cold sends/day per
// Google inbox; new-inbox ramp 5 → 10 → 15 → 20 over the first three weeks;
// send only Mon–Fri, 8am–5pm Eastern.

export const DEFAULT_MAX_DAILY_CAP = 20;

// Cap for weeks 0, 1, 2 after ramp_started_at. Week 3+ uses max_daily_cap.
// Each step is also clamped to max_daily_cap, so a mailbox whose steady
// state is below a ramp value never exceeds its own ceiling.
export const RAMP_STEPS = [5, 10, 15];

export const SEND_WINDOW = {
  timezone: "America/New_York",
  startHour: 8, // inclusive
  endHour: 17, // exclusive (last send fires before 5pm ET)
  weekdaysOnly: true,
} as const;

export interface RampMailbox {
  ramp_started_at: string; // 'YYYY-MM-DD'
  max_daily_cap: number;
  daily_cap_override: number | null;
}

function weeksSince(dateStr: string, now: number): number {
  const started = Date.parse(dateStr);
  if (!Number.isFinite(started)) return RAMP_STEPS.length; // treat unknown as fully ramped
  const days = Math.floor((now - started) / 86_400_000);
  if (days < 0) return 0; // future date → treat as brand new
  return Math.floor(days / 7);
}

/**
 * The number of cold sends this mailbox may make today. A non-null
 * daily_cap_override wins outright; otherwise ramp toward max_daily_cap.
 */
export function effectiveDailyCap(mb: RampMailbox, now: number = Date.now()): number {
  if (mb.daily_cap_override != null) return Math.max(0, mb.daily_cap_override);
  const week = weeksSince(mb.ramp_started_at, now);
  if (week < RAMP_STEPS.length) {
    return Math.min(mb.max_daily_cap, RAMP_STEPS[week]);
  }
  return mb.max_daily_cap;
}

/** Human-facing "week N of ramp" for the mailboxes admin table (1-indexed). */
export function rampWeek(mb: RampMailbox, now: number = Date.now()): number {
  return weeksSince(mb.ramp_started_at, now) + 1;
}

/**
 * The instant (epoch ms) of the most recent midnight in the send-window
 * timezone. Used to count "sent today" against the per-mailbox daily cap on
 * the same ET-day boundary the ramp implies. Derived by subtracting the
 * current ET wall-clock time-of-day from `now`.
 */
export function startOfLocalDay(now: number = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SEND_WINDOW.timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const hour = get("hour") % 24;
  const minute = get("minute");
  const second = get("second");
  const msSinceMidnight = ((hour * 60 + minute) * 60 + second) * 1000;
  return now - msSinceMidnight;
}

/**
 * True when `now` falls inside the Mon–Fri 8am–5pm ET send window. Uses the
 * built-in Intl timezone database (no date-fns tz dep, which isn't installed).
 */
export function isInSendWindow(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SEND_WINDOW.timezone,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourRaw = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hour = Number(hourRaw) % 24; // Intl can render midnight as "24"

  if (SEND_WINDOW.weekdaysOnly && (weekday === "Sat" || weekday === "Sun")) {
    return false;
  }
  return hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour;
}
