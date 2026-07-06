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

export interface SendWindowConfig {
  timezone: string;
  startHour: number; // inclusive
  endHour: number; // exclusive
  weekdaysOnly: boolean;
}

// Global default window, used when a campaign hasn't overridden it (migration
// 00058 added per-campaign columns). Owner default (2026-07-02): Mon–Fri
// 8am–5pm Eastern.
export const SEND_WINDOW: SendWindowConfig = {
  timezone: "America/New_York",
  startHour: 8,
  endHour: 17, // exclusive (last send fires before 5pm)
  weekdaysOnly: true,
};

// Build a full window from a campaign's (possibly-null) override columns,
// falling back to the global default per field. Any NULL column inherits the
// default, so a campaign that only sets a timezone still gets 8–5 weekdays.
export function resolveSendWindow(campaign: {
  send_timezone?: string | null;
  send_start_hour?: number | null;
  send_end_hour?: number | null;
  send_weekdays_only?: boolean | null;
}): SendWindowConfig {
  return {
    timezone: campaign.send_timezone ?? SEND_WINDOW.timezone,
    startHour: campaign.send_start_hour ?? SEND_WINDOW.startHour,
    endHour: campaign.send_end_hour ?? SEND_WINDOW.endHour,
    weekdaysOnly: campaign.send_weekdays_only ?? SEND_WINDOW.weekdaysOnly,
  };
}

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

// Human-readable label for a send window, e.g. "Mon–Fri, 8 AM – 5 PM Pacific
// time". Used on the campaign detail page. endHour is exclusive but reads
// naturally as the closing time (17 -> "5 PM").
const TZ_LABELS: Record<string, string> = {
  "America/Los_Angeles": "Pacific",
  "America/Denver": "Mountain",
  "America/Phoenix": "Arizona",
  "America/Chicago": "Central",
  "America/New_York": "Eastern",
};
export function formatSendWindow(w: SendWindowConfig): string {
  const fmtHour = (h: number) => {
    const hr = ((h % 24) + 24) % 24;
    const period = hr < 12 || hr === 24 ? "AM" : "PM";
    const twelve = hr % 12 === 0 ? 12 : hr % 12;
    return `${twelve} ${period}`;
  };
  const days = w.weekdaysOnly ? "Mon–Fri" : "Every day";
  const tz = TZ_LABELS[w.timezone] ? `${TZ_LABELS[w.timezone]} time` : w.timezone;
  return `${days}, ${fmtHour(w.startHour)} – ${fmtHour(w.endHour)} ${tz}`;
}

/**
 * True when `now` falls inside the given send window (defaults to the global
 * SEND_WINDOW). Pass a per-campaign window from resolveSendWindow() to honor a
 * campaign's own hours/timezone. Uses the built-in Intl timezone database (no
 * date-fns tz dep, which isn't installed).
 */
export function isInSendWindow(
  now: Date = new Date(),
  window: SendWindowConfig = SEND_WINDOW,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timezone,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourRaw = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hour = Number(hourRaw) % 24; // Intl can render midnight as "24"

  if (window.weekdaysOnly && (weekday === "Sat" || weekday === "Sun")) {
    return false;
  }
  return hour >= window.startHour && hour < window.endHour;
}
