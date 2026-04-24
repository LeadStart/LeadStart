import type { Client, ReportFrequency } from "@/types/app";

export interface ScheduleCheck {
  isDue: boolean;
  reason: string;
}

export interface WallClockParts {
  year: number;
  month: number; // 1-12
  dayOfMonth: number;
  dayOfWeek: number; // 0=Sunday, 6=Saturday
  hour: number;
}

/**
 * Decide whether a client is due for their scheduled report at `now`.
 *
 * Contract: called from the hourly cron. A client is "due" when, in their
 * configured timezone, the current wall-clock hour matches their scheduled
 * hour AND today matches their scheduled day per frequency rule. A 23h
 * dedup guard prevents double-sends if the cron runs multiple times in the
 * matching hour (e.g., retry after error).
 */
export function isClientDueNow(
  client: Client,
  now: Date = new Date()
): ScheduleCheck {
  if (!client.report_frequency) return { isDue: false, reason: "no_frequency" };
  if (!client.report_time_of_day) return { isDue: false, reason: "no_time" };
  if (!client.report_timezone) return { isDue: false, reason: "no_timezone" };

  if (client.report_last_sent_at) {
    const lastMs = new Date(client.report_last_sent_at).getTime();
    const hoursSince = (now.getTime() - lastMs) / (1000 * 60 * 60);
    if (hoursSince < 23) return { isDue: false, reason: "recent_send" };
  }

  const [schedHourStr] = client.report_time_of_day.split(":");
  const schedHour = parseInt(schedHourStr, 10);
  if (!Number.isFinite(schedHour) || schedHour < 0 || schedHour > 23) {
    return { isDue: false, reason: "bad_time" };
  }

  const parts = wallClockInZone(now, client.report_timezone);
  if (!parts) return { isDue: false, reason: "bad_timezone" };
  if (parts.hour !== schedHour) return { isDue: false, reason: "wrong_hour" };

  if (client.report_frequency === "weekly") {
    if (client.report_day_of_week == null) {
      return { isDue: false, reason: "no_day_of_week" };
    }
    if (parts.dayOfWeek !== client.report_day_of_week) {
      return { isDue: false, reason: "wrong_dow" };
    }
    return { isDue: true, reason: "weekly_match" };
  }

  if (client.report_frequency === "biweekly") {
    if (client.report_day_of_week == null) {
      return { isDue: false, reason: "no_day_of_week" };
    }
    if (parts.dayOfWeek !== client.report_day_of_week) {
      return { isDue: false, reason: "wrong_dow" };
    }
    // Anchor the "on" week to report_schedule_start. If unset, fall back to a
    // fixed epoch so the cadence is deterministic rather than drifting off
    // whenever someone saves.
    const anchor = client.report_schedule_start
      ? new Date(client.report_schedule_start)
      : new Date("2024-01-01T00:00:00Z");
    const daysSinceAnchor = Math.floor(
      (now.getTime() - anchor.getTime()) / (1000 * 60 * 60 * 24)
    );
    const weekIndex = Math.floor(daysSinceAnchor / 7);
    if (weekIndex % 2 !== 0) return { isDue: false, reason: "off_week" };
    return { isDue: true, reason: "biweekly_match" };
  }

  if (client.report_frequency === "monthly") {
    if (client.report_day_of_month == null) {
      return { isDue: false, reason: "no_day_of_month" };
    }
    const target =
      client.report_day_of_month === -1
        ? lastDayOfMonth(parts.year, parts.month)
        : client.report_day_of_month;
    if (parts.dayOfMonth !== target) {
      return { isDue: false, reason: "wrong_dom" };
    }
    return { isDue: true, reason: "monthly_match" };
  }

  return { isDue: false, reason: "unknown_frequency" };
}

function wallClockInZone(date: Date, timezone: string): WallClockParts | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const get = (type: string) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const weekdayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    let hour = parseInt(get("hour"), 10);
    // Intl can emit '24' for midnight under some locale/tz combos.
    if (hour === 24) hour = 0;
    return {
      year: parseInt(get("year"), 10),
      month: parseInt(get("month"), 10),
      dayOfMonth: parseInt(get("day"), 10),
      dayOfWeek: weekdayMap[get("weekday")] ?? 0,
      hour,
    };
  } catch {
    return null;
  }
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export const WEEKDAY_LABELS: { value: number; label: string; short: string }[] = [
  { value: 0, label: "Sunday", short: "Sun" },
  { value: 1, label: "Monday", short: "Mon" },
  { value: 2, label: "Tuesday", short: "Tue" },
  { value: 3, label: "Wednesday", short: "Wed" },
  { value: 4, label: "Thursday", short: "Thu" },
  { value: 5, label: "Friday", short: "Fri" },
  { value: 6, label: "Saturday", short: "Sat" },
];

export const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Phoenix", label: "Arizona (no DST)" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris / Berlin" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "UTC", label: "UTC" },
];

export function describeSchedule(client: Pick<Client,
  "report_frequency" | "report_day_of_week" | "report_day_of_month" |
  "report_time_of_day" | "report_timezone"
>): string | null {
  if (!client.report_frequency) return null;
  const time = client.report_time_of_day || "—";
  const tz = client.report_timezone || "UTC";

  if (client.report_frequency === "weekly" || client.report_frequency === "biweekly") {
    const dow = client.report_day_of_week;
    if (dow == null) return null;
    const dowLabel = WEEKDAY_LABELS[dow]?.label ?? `Day ${dow}`;
    const prefix = client.report_frequency === "biweekly" ? "Every other " : "Every ";
    return `${prefix}${dowLabel} at ${time} (${tz})`;
  }

  if (client.report_frequency === "monthly") {
    const dom = client.report_day_of_month;
    if (dom == null) return null;
    const dayLabel = dom === -1 ? "the last day" : ordinal(dom);
    return `Monthly on ${dayLabel} at ${time} (${tz})`;
  }

  return null;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `the ${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function frequencyBadgeLabel(freq: ReportFrequency): string {
  if (freq === "weekly") return "Weekly";
  if (freq === "biweekly") return "Biweekly";
  return "Monthly";
}
