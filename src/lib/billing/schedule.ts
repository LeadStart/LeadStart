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
