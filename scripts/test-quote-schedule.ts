// Unit test for resolveQuoteSchedule (src/lib/billing/schedule.ts).
//
// The regression it guards: a quote's acceptance window must NEVER be silently
// shortened to fit before launch. Short-warming or soon-launch quotes used to
// get their expiry clamped to the day before launch, so a 7-day quote pinned to
// launch in 6 days ended up valid for only ~5. The fix pushes launch OUT past
// the expiry instead. This test proves expiry is preserved and launch always
// clears it, while leaving normal quotes untouched.
//
// Run:  npx tsx scripts/test-quote-schedule.ts

import {
  resolveQuoteSchedule,
  computeLaunchDate,
  DEFAULT_WARMING_DAYS,
  DEFAULT_QUOTE_EXPIRY_DAYS,
} from "../src/lib/billing/schedule";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const dayFloor = (d: Date) =>
  Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const windowDays = (from: Date, expiresAt: string) =>
  (dayFloor(new Date(expiresAt)) - dayFloor(from)) / DAY;
const isWeekday = (d: Date) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
// Mirror the admin form: expiry = date(from + n) at 00:00 UTC (YYYY-MM-DD).
const expiryDateOnly = (from: Date, n: number) => {
  const x = new Date(dayFloor(from));
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

// A deterministic reference "now". (Weekday-agnostic: assertions compare against
// the functions' own output or check invariants, so the exact day never matters.)
const FROM = new Date("2026-09-07T09:00:00Z");

console.log("resolveQuoteSchedule:");

// 1) Default quote (warming 14, expiry +7): fits comfortably, nothing moves.
{
  const expiresAt = expiryDateOnly(FROM, DEFAULT_QUOTE_EXPIRY_DAYS);
  const r = resolveQuoteSchedule({
    from: FROM,
    warmingDays: DEFAULT_WARMING_DAYS,
    launchMode: "derived",
    expiresAt,
  });
  ok(r.expiresAt === expiresAt, "default: expiry unchanged");
  ok(r.warmingDays === DEFAULT_WARMING_DAYS, "default: warming unchanged (14)");
  ok(
    r.launch.getTime() ===
      computeLaunchDate(FROM, DEFAULT_WARMING_DAYS).getTime(),
    "default: launch == derived launch (no push)",
  );
  ok(r.launch.getTime() > new Date(expiresAt).getTime(), "default: launch > expiry");
}

// 2) Short-warming derived (warming 3, expiry +7): launch must be PUSHED so the
//    7-day window survives; old code would have clamped expiry down.
{
  const expiresAt = expiryDateOnly(FROM, DEFAULT_QUOTE_EXPIRY_DAYS);
  const r = resolveQuoteSchedule({
    from: FROM,
    warmingDays: 3,
    launchMode: "derived",
    expiresAt,
  });
  ok(r.expiresAt === expiresAt, "short-warm: expiry preserved (not clamped)");
  ok(windowDays(FROM, r.expiresAt!) === 7, "short-warm: full 7-day window kept");
  ok(r.launch.getTime() > new Date(expiresAt).getTime(), "short-warm: launch > expiry");
  ok(isWeekday(r.launch), "short-warm: launch lands on a weekday");
  ok(r.warmingDays > 3, "short-warm: warming grew to match pushed launch");
  ok(
    r.warmingDays === (dayFloor(r.launch) - dayFloor(FROM)) / DAY,
    "short-warm: warming == calendar days send->launch",
  );
  // Prove behavior actually changed vs the old clamp.
  const oldLaunch = computeLaunchDate(FROM, 3);
  const oldClampedExpiry = new Date(oldLaunch.getTime() - DAY).toISOString();
  ok(
    new Date(r.expiresAt!).getTime() > new Date(oldClampedExpiry).getTime(),
    "short-warm: new expiry is later than the old clamped value",
  );
}

// 3) Fixed soon launch (the Astro Jump shape): pinned launch +5, expiry +7.
{
  const fixedLaunchDate = expiryDateOnly(FROM, 5); // reuse YYYY-MM-DD helper
  const expiresAt = expiryDateOnly(FROM, DEFAULT_QUOTE_EXPIRY_DAYS);
  const r = resolveQuoteSchedule({
    from: FROM,
    warmingDays: 5,
    launchMode: "fixed",
    fixedLaunchDate,
    expiresAt,
  });
  ok(r.expiresAt === expiresAt, "fixed-soon: expiry preserved");
  ok(windowDays(FROM, r.expiresAt!) === 7, "fixed-soon: full 7-day window kept");
  ok(r.launch.getTime() > new Date(expiresAt).getTime(), "fixed-soon: launch pushed past expiry");
  ok(isWeekday(r.launch), "fixed-soon: launch lands on a weekday");
}

// 4) No expiry (open-ended): intended launch stands, nothing recomputed.
{
  const r = resolveQuoteSchedule({
    from: FROM,
    warmingDays: 10,
    launchMode: "derived",
    expiresAt: null,
  });
  ok(r.expiresAt === null, "no-expiry: expiry stays null");
  ok(
    r.launch.getTime() === computeLaunchDate(FROM, 10).getTime(),
    "no-expiry: launch == derived launch",
  );
  ok(r.warmingDays === 10, "no-expiry: warming unchanged");
}

// 5) Expiry already well before launch (warming 14, expiry +3): no push.
{
  const expiresAt = expiryDateOnly(FROM, 3);
  const r = resolveQuoteSchedule({
    from: FROM,
    warmingDays: DEFAULT_WARMING_DAYS,
    launchMode: "derived",
    expiresAt,
  });
  ok(
    r.launch.getTime() ===
      computeLaunchDate(FROM, DEFAULT_WARMING_DAYS).getTime(),
    "early-expiry: launch unchanged (no push)",
  );
  ok(r.warmingDays === DEFAULT_WARMING_DAYS, "early-expiry: warming unchanged");
}

// 6) Invariant sweep: for ANY warming 1..20 with a 7-day window, the window is
//    always exactly 7 days and launch always strictly clears expiry.
{
  let allGood = true;
  for (let w = 1; w <= 20; w++) {
    const expiresAt = expiryDateOnly(FROM, DEFAULT_QUOTE_EXPIRY_DAYS);
    const r = resolveQuoteSchedule({
      from: FROM,
      warmingDays: w,
      launchMode: "derived",
      expiresAt,
    });
    if (
      r.expiresAt !== expiresAt ||
      windowDays(FROM, r.expiresAt!) !== 7 ||
      r.launch.getTime() <= new Date(expiresAt).getTime() ||
      !isWeekday(r.launch)
    ) {
      allGood = false;
      console.log(`     warming=${w} broke the invariant`);
    }
  }
  ok(allGood, "sweep: 7-day window preserved + launch clears it for warming 1..20");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
