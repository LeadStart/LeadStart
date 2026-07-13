// Per-mailbox inbox-health scorer for the native email channel.
//
// Pure function over already-collected signals — no I/O here, so it's trivially
// testable and safe to import anywhere (all cross-module imports are types,
// erased at compile time, so nothing pulls node:dns into a client bundle).
// The cron (/api/cron/check-inbox-health) gathers the inputs (DNS, Spamhaus
// DBL, native_sends bounce stats) and calls this.
//
// Model: start at 100, subtract a fixed penalty per unhealthy signal. A signal
// we couldn't measure (no data, sample too small, no key) is reported as
// "unchecked" with a zero penalty — never guessed, never punished. So a
// brand-new mailbox with good DNS and no send/warmup history scores 100 with
// several "unchecked" rows visible, rather than being dinged for missing data.
//
// Bands mirror the client-health badge convention (src/lib/kpi/definitions.ts):
//   healthy  score >= 80   (badge-green)
//   watch    50–79         (badge-amber)
//   critical < 50          (badge-red)
//
// Penalty weights (single source of truth — the table below is the spec):
//   blacklist (DBL listed)                         -60
//   SPF        fail -15 / warn -5
//   DKIM       fail -15 / warn -5   (check.ts only ever warns for DKIM)
//   DMARC      fail -10 / warn -5   (fail = record missing)
//   MX         fail -20
//   bounce 7d  >10% -60 / 5–10% -40 / 2–5% -15   (only when >= 20 sends)
//
// Sanity anchors (used by scripts/test-inbox-health.ts): perfect = 100/healthy;
// DBL-listed alone = 40/critical; >10% bounces alone = 40/critical; a total DNS
// resolver outage (SPF fail + DKIM warn + DMARC fail + MX fail) = exactly
// 50/watch; empty inputs = 100/healthy with every component "unchecked".

import type { HealthBand, HealthComponent } from "@/types/app";
import type { AuthCheck, DomainAuth } from "./check";
import type { DblResult } from "./dnsbl";

export const HEALTHY_MIN = 80;
export const CRITICAL_MAX = 49; // score <= 49 is critical (i.e. below 50)
export const MIN_SENT_FOR_BOUNCE_SCORE = 20; // mirrors kpi/step-health MIN_SENT_FOR_ALERT

export interface InboxHealthInputs {
  /** Spamhaus DBL result. null/undefined → blacklist via DBL not checked. */
  dbl?: DblResult | null;
  /** SPF/DKIM/DMARC from checkDomainAuth. null → those three unchecked. */
  domainAuth?: DomainAuth | null;
  /** MX from checkMx. null → MX unchecked. */
  mx?: AuthCheck | null;
  /** 7-day send/bounce counts from native_sends. null → bounce rate unchecked. */
  bounces?: { sent7d: number; bounced7d: number } | null;
}

export interface InboxHealthResult {
  score: number; // clamped 0–100
  band: HealthBand;
  components: HealthComponent[]; // all 6, always, in fixed order
}

export function computeInboxHealth(inputs: InboxHealthInputs): InboxHealthResult {
  const { dbl, domainAuth, mx, bounces } = inputs;

  const components: HealthComponent[] = [
    blacklistComponent(dbl),
    authComponent("spf", "SPF", domainAuth?.spf, { fail: 15, warn: 5 }, "SPF not checked."),
    authComponent("dkim", "DKIM", domainAuth?.dkim, { fail: 15, warn: 5 }, "DKIM not checked."),
    authComponent("dmarc", "DMARC", domainAuth?.dmarc, { fail: 10, warn: 5 }, "DMARC not checked."),
    authComponent("mx", "MX records", mx, { fail: 20, warn: 10 }, "MX not checked."),
    bounceComponent(bounces),
  ];

  const totalDeduction = components.reduce((sum, c) => sum + c.deduction, 0);
  const score = Math.max(0, Math.min(100, 100 - totalDeduction));
  return { score, band: bandForScore(score), components };
}

export function bandForScore(score: number): HealthBand {
  if (score >= HEALTHY_MIN) return "healthy";
  if (score > CRITICAL_MAX) return "watch";
  return "critical";
}

export function bandBadgeClass(band: HealthBand): string {
  switch (band) {
    case "healthy":
      return "badge-green";
    case "watch":
      return "badge-amber";
    case "critical":
      return "badge-red";
  }
}

export function bandLabel(band: HealthBand): string {
  switch (band) {
    case "healthy":
      return "Healthy";
    case "watch":
      return "Watch";
    case "critical":
      return "Critical";
  }
}

/**
 * One-line, plain-language summary of what's wrong — the `detail` of every
 * component that's "bad", falling back to "warn" if nothing is outright bad.
 * Used in owner-alert bodies. Empty string when the mailbox is clean.
 */
export function summarizeIssues(components: HealthComponent[]): string {
  const bad = components.filter((c) => c.status === "bad");
  const pool = bad.length > 0 ? bad : components.filter((c) => c.status === "warn");
  return pool.map((c) => c.detail).join(" ");
}

// ── Component builders ───────────────────────────────────────────────────

function authComponent(
  key: HealthComponent["key"],
  label: string,
  check: AuthCheck | null | undefined,
  weights: { fail: number; warn: number },
  uncheckedDetail: string,
): HealthComponent {
  if (!check) return { key, label, status: "unchecked", deduction: 0, detail: uncheckedDetail };
  if (check.status === "fail")
    return { key, label, status: "bad", deduction: weights.fail, detail: check.detail };
  if (check.status === "warn")
    return { key, label, status: "warn", deduction: weights.warn, detail: check.detail };
  return { key, label, status: "ok", deduction: 0, detail: check.detail };
}

function blacklistComponent(dbl: DblResult | null | undefined): HealthComponent {
  const key: HealthComponent["key"] = "blacklist";
  const label = "Domain blacklist";

  if (dbl?.status === "listed") {
    return { key, label, status: "bad", deduction: 60, detail: dbl.detail };
  }

  // Affirmatively clean only if the DBL check actually cleared it.
  if (dbl?.status === "clean") {
    return { key, label, status: "ok", deduction: 0, detail: dbl.detail };
  }
  return {
    key,
    label,
    status: "unchecked",
    deduction: 0,
    detail: dbl?.detail ?? "Blacklist not checked (no Spamhaus key).",
  };
}

function bounceComponent(
  bounces: { sent7d: number; bounced7d: number } | null | undefined,
): HealthComponent {
  const key: HealthComponent["key"] = "bounce_rate";
  const label = "Bounce rate (7 days)";
  const sent = bounces?.sent7d ?? 0;
  if (!bounces || sent < MIN_SENT_FOR_BOUNCE_SCORE) {
    return {
      key,
      label,
      status: "unchecked",
      deduction: 0,
      detail: `Only ${sent} send${sent === 1 ? "" : "s"} in the last 7 days — need ${MIN_SENT_FOR_BOUNCE_SCORE} to score bounce rate.`,
    };
  }
  const rate = bounces.bounced7d / bounces.sent7d;
  const detail = `${bounces.bounced7d} of ${bounces.sent7d} sends bounced this week (${(rate * 100).toFixed(1)}%).`;
  if (rate > 0.1) return { key, label, status: "bad", deduction: 60, detail };
  if (rate > 0.05) return { key, label, status: "bad", deduction: 40, detail };
  if (rate > 0.02) return { key, label, status: "warn", deduction: 15, detail };
  return { key, label, status: "ok", deduction: 0, detail };
}
