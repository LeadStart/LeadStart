// Warm-up → launch scheduling. Sending happens Monday–Friday only, so the
// launch day (and the first monthly charge, which lands on launch day) is the
// warm-up window in calendar days rolled forward to the next sending day.

// Onboarding defaults: the single source of truth. Both the client-facing
// surfaces (quote email + hosted quote page + welcome page + the quotes API)
// and the admin Onboarding preview import these, so a change here propagates
// everywhere at once. scripts/test-onboarding-preview-sync.ts enforces that the
// consumers keep importing them instead of re-hard-coding a literal.

/** Default warm-up window in calendar days when a quote doesn't specify one. */
export const DEFAULT_WARMING_DAYS = 14;

/** Default number of days a freshly-drafted quote stays valid. */
export const DEFAULT_QUOTE_EXPIRY_DAYS = 7;

/** First Mon–Fri on or after `d`. */
export function nextBusinessDay(d: Date): Date {
  const x = new Date(d);
  while (x.getDay() === 0 || x.getDay() === 6) {
    x.setDate(x.getDate() + 1);
  }
  return x;
}

/**
 * Launch day = `from` + `warmingDays` calendar days, rolled to the next
 * sending day (Mon–Fri). This is also when the first monthly charge is assessed.
 */
export function computeLaunchDate(from: Date, warmingDays: number): Date {
  const end = new Date(from);
  end.setDate(end.getDate() + Math.max(0, Math.floor(warmingDays)));
  return nextBusinessDay(end);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the frozen launch (first-charge) date, the warm-up length to store,
 * and the expiry to persist for a quote from the admin's inputs. Shared by the
 * create and edit routes so the two never drift.
 *
 * The acceptance window (`expiresAt`) is a promise to the client, so it is never
 * shortened. Previously an over-long expiry was clamped to the day before
 * launch, which silently handed short-warming or soon-launch quotes a
 * sub-`DEFAULT_QUOTE_EXPIRY_DAYS` window (e.g. a 7-day quote pinned to launch in
 * 6 days ended up valid for only 5). Instead the launch is pushed out to the
 * first business day AFTER expiry, so warm-up only ever grows. `warmingDays` is
 * recomputed in step with a pushed-out launch so the client-facing "N calendar
 * days of warming" matches the shown first-charge date. With no expiry set, or
 * when the intended launch already clears the window, everything stands as-is.
 */
export function resolveQuoteSchedule(input: {
  /** "now" for the create/edit; drives the derived launch and warm-up count. */
  from: Date;
  /** Admin-requested warm-up window in calendar days. */
  warmingDays: number;
  launchMode: "derived" | "fixed";
  /** Admin-pinned launch date (YYYY-MM-DD); only read when launchMode==="fixed". */
  fixedLaunchDate?: string | null;
  /** Requested acceptance-window end (ISO or YYYY-MM-DD), if any. */
  expiresAt?: string | null;
}): { launch: Date; warmingDays: number; expiresAt: string | null } {
  const { from, warmingDays, launchMode, fixedLaunchDate } = input;
  const expiresAt = input.expiresAt ?? null;

  let launch =
    launchMode === "fixed" && fixedLaunchDate
      ? nextBusinessDay(new Date(fixedLaunchDate))
      : computeLaunchDate(from, warmingDays);
  let storedWarmingDays = warmingDays;

  if (expiresAt) {
    // Launch must clear the acceptance window: first business day AFTER expiry.
    const minLaunch = nextBusinessDay(
      new Date(new Date(expiresAt).getTime() + DAY_MS),
    );
    if (minLaunch.getTime() > launch.getTime()) {
      launch = minLaunch;
      // Whole calendar days send→launch (date-to-date, so the time-of-day of
      // `from` never skews the shown count), floored at the requested warm-up.
      const dayFloor = (d: Date) =>
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      storedWarmingDays = Math.max(
        warmingDays,
        Math.round((dayFloor(launch) - dayFloor(from)) / DAY_MS),
      );
    }
  }

  return { launch, warmingDays: storedWarmingDays, expiresAt };
}
