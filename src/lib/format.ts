// Shared number, money and date formatting. Intl-based with a fixed locale and
// no timezone reads, so the server render and the browser render print the
// same text. (Older pages each keep a local formatCents; new code uses these.)

const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usdCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdPrecise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** $1,234 by default; `cents` → $1,234.56; `precise` → up to 4 decimals ($0.0037). */
export function formatUsd(n: number, opts: { cents?: boolean; precise?: boolean } = {}): string {
  if (!Number.isFinite(n)) return "-";
  if (opts.precise) return usdPrecise.format(n);
  return (opts.cents ? usdCents : usdWhole).format(n);
}

export function formatInt(n: number): string {
  return Number.isFinite(n) ? whole.format(Math.round(n)) : "-";
}

export function formatNumber(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(n);
}

export function formatPct(n: number, digits = 1): string {
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : "-";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-10-30" → "Oct 30, 2026" (or "Fri, Oct 30, 2026" / "Oct 30"). */
export function formatCivilDate(
  s: string | null | undefined,
  opts: { weekday?: boolean; year?: boolean } = {},
): string {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return "-";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const day = `${MONTHS[mo - 1]} ${d}`;
  return `${opts.weekday ? `${WEEKDAYS[wd]}, ` : ""}${day}${opts.year === false ? "" : `, ${y}`}`;
}
