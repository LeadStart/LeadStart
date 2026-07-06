// Pure send-pacing math for the native email channel. "Ramp as data": a
// brand-new inbox starts at a low daily cap and steps up as it ACTUALLY sends
// — the cap is a function of the mailbox's cumulative send count, not calendar
// time. So a paused or idle inbox stays early in the ramp until it truly warms
// up; pausing an inbox for weeks can no longer fast-forward it to full volume.
// No vendor warmup product, no state machine — just arithmetic over the send
// count the worker passes in each tick.
//
// Owner-chosen defaults: steady state 20 cold sends/day per Google inbox;
// warmup 5 → 10 → 15 → 20, each stage lasting ~one business-week of sending at
// that stage's cap. Send window is Mon–Fri business hours (per campaign).

export const DEFAULT_MAX_DAILY_CAP = 20;

// Warmup stages, in order: { cap: sends/day at this stage; graduateAt:
// cumulative sends at which the mailbox leaves this stage }. 5/day for a
// business-week (5×5 = 25) → 10/day (+50 ⇒ 75) → 15/day (+75 ⇒ 150) → then the
// mailbox's own max_daily_cap. Each cap is clamped to max_daily_cap, so a
// mailbox whose ceiling is below a stage value never exceeds it.
export const RAMP_STAGES: { cap: number; graduateAt: number }[] = [
  { cap: 5, graduateAt: 25 },
  { cap: 10, graduateAt: 75 },
  { cap: 15, graduateAt: 150 },
];

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
 * daily_cap_override wins outright; otherwise the cap steps up with cumulative
 * send volume — so an inbox that hasn't sent stays at the low starting cap.
 */
export function effectiveDailyCap(mb: RampMailbox, totalSent: number): number {
  if (mb.daily_cap_override != null) return Math.max(0, mb.daily_cap_override);
  for (const stage of RAMP_STAGES) {
    if (totalSent < stage.graduateAt) return Math.min(mb.max_daily_cap, stage.cap);
  }
  return mb.max_daily_cap;
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
