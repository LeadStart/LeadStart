// Per-mailbox inbox-health scorer for the native email channel.
//
// Pure function over already-collected signals — no I/O here, so it's trivially
// testable and safe to import anywhere (all cross-module imports are types,
// erased at compile time, so nothing pulls node:dns into a client bundle).
// The cron (/api/cron/check-inbox-health) gathers the inputs (DNS, Spamhaus
// DBL, native_sends bounce stats, Warmforge) and calls this.
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
//   blacklist (DBL listed OR Warmforge-reported)   -60
//   SPF        fail -15 / warn -5
//   DKIM       fail -15 / warn -5   (check.ts only ever warns for DKIM)
//   DMARC      fail -10 / warn -5   (fail = record missing)
//   MX         fail -20
//   bounce 7d  >10% -60 / 5–10% -40 / 2–5% -15   (only when >= 20 sends)
//   heat score < 40 -25 / 40–69 -10             (Warmforge)
//   warmup spam placement > 20% -25 / 10–20% -10 (Warmforge, sample >= 20)
//
// Sanity anchors (used by scripts/test-inbox-health.ts): perfect = 100/healthy;
// DBL-listed alone = 40/critical; >10% bounces alone = 40/critical; a total DNS
// resolver outage (SPF fail + DKIM warn + DMARC fail + MX fail) = exactly
// 50/watch; empty inputs = 100/healthy with every component "unchecked".

import type { HealthBand, HealthComponent } from "@/types/app";
import type { AuthCheck, DomainAuth } from "./check";
import type { DblResult } from "./dnsbl";
import type { WarmforgeMailbox } from "@/lib/warmforge/types";

export const HEALTHY_MIN = 80;
export const CRITICAL_MAX = 49; // score <= 49 is critical (i.e. below 50)
export const MIN_SENT_FOR_BOUNCE_SCORE = 20; // mirrors kpi/step-health MIN_SENT_FOR_ALERT
export const MIN_WARMUP_SAMPLE = 20;

export interface InboxHealthInputs {
  /** Spamhaus DBL result. null/undefined → blacklist via DBL not checked. */
  dbl?: DblResult | null;
  /** SPF/DKIM/DMARC from checkDomainAuth. null → those three unchecked. */
  domainAuth?: DomainAuth | null;
  /** MX from checkMx. null → MX unchecked. */
  mx?: AuthCheck | null;
  /** 7-day send/bounce counts from native_sends. null → bounce rate unchecked. */
  bounces?: { sent7d: number; bounced7d: number } | null;
  /** Warmforge per-mailbox payload. null → heat/placement/vendor-blacklist unchecked. */
  warmforge?: WarmforgeMailbox | null;
}

export interface InboxHealthResult {
  score: number; // clamped 0–100
  band: HealthBand;
  components: HealthComponent[]; // all 8, always, in fixed order
}

export function computeInboxHealth(inputs: InboxHealthInputs): InboxHealthResult {
  const { dbl, domainAuth, mx, bounces, warmforge } = inputs;

  const components: HealthComponent[] = [
    blacklistComponent(dbl, warmforge),
    authComponent("spf", "SPF", domainAuth?.spf, { fail: 15, warn: 5 }, "SPF not checked."),
    authComponent("dkim", "DKIM", domainAuth?.dkim, { fail: 15, warn: 5 }, "DKIM not checked."),
    authComponent("dmarc", "DMARC", domainAuth?.dmarc, { fail: 10, warn: 5 }, "DMARC not checked."),
    authComponent("mx", "MX records", mx, { fail: 20, warn: 10 }, "MX not checked."),
    bounceComponent(bounces),
    heatComponent(warmforge),
    placementComponent(warmforge),
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

function blacklistComponent(
  dbl: DblResult | null | undefined,
  warmforge: WarmforgeMailbox | null | undefined,
): HealthComponent {
  const key: HealthComponent["key"] = "blacklist";
  const label = "Domain blacklist";
  const wfListed = warmforge?.blacklisted === true;

  if (dbl?.status === "listed" || wfListed) {
    const parts: string[] = [];
    if (dbl?.status === "listed") parts.push(dbl.detail);
    if (wfListed) {
      const names = warmforge?.blacklists?.length ? ` (${warmforge.blacklists.join(", ")})` : "";
      parts.push(`Warmforge reports this mailbox as blacklisted${names}.`);
    }
    return { key, label, status: "bad", deduction: 60, detail: parts.join(" ") };
  }

  // Affirmatively clean only if a source actually checked and cleared it.
  if (dbl?.status === "clean") {
    return { key, label, status: "ok", deduction: 0, detail: dbl.detail };
  }
  if (warmforge?.blacklisted === false) {
    return { key, label, status: "ok", deduction: 0, detail: "Not blacklisted per Warmforge." };
  }
  return {
    key,
    label,
    status: "unchecked",
    deduction: 0,
    detail: dbl?.detail ?? "Blacklist not checked (no Spamhaus key and no Warmforge data).",
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

function heatComponent(warmforge: WarmforgeMailbox | null | undefined): HealthComponent {
  const key: HealthComponent["key"] = "heat_score";
  const label = "Warmup reputation";
  const heat = warmforge?.heat_score;
  if (typeof heat !== "number") {
    return { key, label, status: "unchecked", deduction: 0, detail: "No Warmforge heat score for this mailbox." };
  }
  const detail = `Warmforge heat score ${heat}/100.`;
  if (heat < 40) return { key, label, status: "bad", deduction: 25, detail };
  if (heat < 70) return { key, label, status: "warn", deduction: 10, detail };
  return { key, label, status: "ok", deduction: 0, detail };
}

function placementComponent(warmforge: WarmforgeMailbox | null | undefined): HealthComponent {
  const key: HealthComponent["key"] = "warmup_placement";
  const label = "Warmup inbox placement";
  const inbox = warmforge?.warmup_landed_inbox;
  const spam = warmforge?.warmup_landed_spam;
  if (typeof inbox !== "number" || typeof spam !== "number" || inbox + spam < MIN_WARMUP_SAMPLE) {
    return { key, label, status: "unchecked", deduction: 0, detail: "Not enough Warmforge warmup placement data yet." };
  }
  const total = inbox + spam;
  const spamRate = spam / total;
  const detail = `${spam} of ${total} warmup emails landed in spam (${(spamRate * 100).toFixed(0)}%).`;
  if (spamRate > 0.2) return { key, label, status: "bad", deduction: 25, detail };
  if (spamRate > 0.1) return { key, label, status: "warn", deduction: 10, detail };
  return { key, label, status: "ok", deduction: 0, detail };
}
