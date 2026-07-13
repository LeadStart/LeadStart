// Pure send-pacing math for the native email channel. "Ramp as data": a
// brand-new inbox starts at a low daily cap and steps up as it ACTUALLY sends
// — the cap is a function of the mailbox's cumulative send count, not calendar
// time. So a paused or idle inbox stays early in the ramp until it truly warms
// up; pausing an inbox for weeks can no longer fast-forward it to full volume.
// No vendor warmup product, no state machine — just arithmetic over the send
// count the worker passes in each tick.
//
// Owner-chosen cadence: a new inbox opens at 5 cold sends/day and gains +1/day
// as it warms — 5 → 6 → 7 → … → 20 — capping at 20/day, the steady state. The
// ramp is expressed as cumulative-send thresholds (below) rather than calendar
// days so it stays "ramp as data": when an inbox sends its full allotment each
// day the cap climbs by exactly one per day, but an idle/paused inbox holds its
// place instead of fast-forwarding. 20/day per inbox is a HARD ceiling nothing
// may exceed — not a per-mailbox max, not an override (see
// ABSOLUTE_MAX_DAILY_CAP). Send window is Mon–Fri business hours (per campaign).

// The absolute per-inbox daily send ceiling. This is a safety invariant, not a
// tunable default: no mailbox may EVER send more than this many cold emails in
// one day, regardless of its max_daily_cap or daily_cap_override.
// effectiveDailyCap() clamps every path to it, so the guarantee holds even
// against a stale/oversized DB value.
export const ABSOLUTE_MAX_DAILY_CAP = 20;

export const DEFAULT_MAX_DAILY_CAP = 20;

// Warmup stages, in order: { cap: sends/day at this stage; graduateAt:
// cumulative sends at which the mailbox leaves it }. Each graduateAt is the
// running total of every cap up to and including this stage (5, 5+6, 5+6+7, …),
// so an inbox that sends its full cap every day advances exactly one stage per
// day: 5 → 6 → 7 → … → 19, then it graduates to its own max_daily_cap
// (default 20 = ABSOLUTE_MAX_DAILY_CAP). Each cap is clamped to the mailbox's
// ceiling, so a mailbox whose max is below a stage value never exceeds it and
// simply holds there.
export const RAMP_STAGES: { cap: number; graduateAt: number }[] = [
  { cap: 5, graduateAt: 5 },
  { cap: 6, graduateAt: 11 },
  { cap: 7, graduateAt: 18 },
  { cap: 8, graduateAt: 26 },
  { cap: 9, graduateAt: 35 },
  { cap: 10, graduateAt: 45 },
  { cap: 11, graduateAt: 56 },
  { cap: 12, graduateAt: 68 },
  { cap: 13, graduateAt: 81 },
  { cap: 14, graduateAt: 95 },
  { cap: 15, graduateAt: 110 },
  { cap: 16, graduateAt: 126 },
  { cap: 17, graduateAt: 143 },
  { cap: 18, graduateAt: 161 },
  { cap: 19, graduateAt: 180 },
];

// Per-campaign cap on how many BRAND-NEW leads (step-0 first-touches) may start
// the sequence per day, independent of inbox capacity — so a big import can't
// crowd out follow-ups and new-lead velocity is controllable per campaign.
// Follow-ups (step 1+) are never limited by this. NULL on a campaign inherits
// this default (migration 00064); 0 pauses new leads while follow-ups continue.
export const DEFAULT_DAILY_NEW_LEADS_CAP = 20;

// Resolve a campaign's effective new-leads/day cap: its own value, or the
// global default when unset. Same "NULL = inherit default" shape as
// resolveSendWindow below.
export function resolveDailyNewLeadsCap(campaign: {
  daily_new_leads_cap?: number | null;
}): number {
  const v = campaign.daily_new_leads_cap;
  return v == null ? DEFAULT_DAILY_NEW_LEADS_CAP : Math.max(0, v);
}

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
  max_daily_cap: number;
  daily_cap_override: number | null;
}

/**
 * The number of cold sends this mailbox may make today, given how many emails
 * it has already sent all-time (`totalSent`, from native_sends). A non-null
 * daily_cap_override bypasses the ramp; otherwise the cap steps up with
 * cumulative send volume — so an inbox that hasn't sent stays at the low
 * starting cap. EVERY path is clamped to ABSOLUTE_MAX_DAILY_CAP (and to the
 * mailbox's own max_daily_cap), so the result can never exceed 20/day — this
 * function is the single chokepoint the send worker reads, so the hard cap is
 * enforced here even if a bad value reaches the DB.
 */
export function effectiveDailyCap(mb: RampMailbox, totalSent: number): number {
  const ceiling = Math.min(mb.max_daily_cap, ABSOLUTE_MAX_DAILY_CAP);
  if (mb.daily_cap_override != null) {
    return Math.max(0, Math.min(ceiling, mb.daily_cap_override));
  }
  for (const stage of RAMP_STAGES) {
    if (totalSent < stage.graduateAt) return Math.min(ceiling, stage.cap);
  }
  return ceiling;
}

/**
 * Human-facing ramp position for the mailboxes admin table: the warmup stage
 * (1-indexed), the total number of stages (warmup + steady), and whether the
 * mailbox is fully warmed (past the last warmup stage).
 */
export function rampStage(totalSent: number): {
  stage: number;
  stages: number;
  warmed: boolean;
} {
  const stages = RAMP_STAGES.length + 1; // warmup stages + steady state
  for (let i = 0; i < RAMP_STAGES.length; i++) {
    if (totalSent < RAMP_STAGES[i].graduateAt) {
      return { stage: i + 1, stages, warmed: false };
    }
  }
  return { stage: stages, stages, warmed: true };
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

// ── Send pacing ───────────────────────────────────────────────────────────
// Sends from one inbox are spread across its send window instead of fired in a
// burst. The gap between two sends from the same inbox is the day's remaining
// allotment spread evenly over the time left in the window, floored at
// MIN_SEND_GAP_MINUTES so an inbox never sends faster than that.

export const MIN_SEND_GAP_MINUTES = 5;

// Minutes from `now` until the send window closes TODAY, in the window's
// timezone. 0 once at/after the end hour, or on a non-send weekday.
export function minutesUntilWindowClose(
  now: Date = new Date(),
  window: SendWindowConfig = SEND_WINDOW,
): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (window.weekdaysOnly && (weekday === "Sat" || weekday === "Sun")) return 0;
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return Math.max(0, window.endHour * 60 - (hour * 60 + minute));
}

// The minimum minutes that must elapse between two sends from one inbox: spread
// `remainingSends` evenly over the `remainingWindowMinutes` left today, but
// never tighter than MIN_SEND_GAP_MINUTES. Returns Infinity when nothing is
// left to send (so the caller never fires). When the window is too short to fit
// the remaining sends at the 5-min floor, the floor wins — throughput is capped
// rather than the spacing violated (the worker logs when this happens).
export function sendSpacingMinutes(
  remainingWindowMinutes: number,
  remainingSends: number,
): number {
  if (remainingSends <= 0) return Infinity;
  return Math.max(MIN_SEND_GAP_MINUTES, remainingWindowMinutes / remainingSends);
}
