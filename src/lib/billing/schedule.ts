// Warm-up → launch scheduling. Sending happens Monday–Friday only, so the
// launch day (and the first monthly charge, which lands on launch day) is the
// warm-up window in calendar days rolled forward to the next sending day.

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
