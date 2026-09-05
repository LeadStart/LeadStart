// Per-mailbox inbox-health scorer for the native email channel.
//
// Pure function over already-collected signals: no I/O here, so it's trivially
// testable and safe to import anywhere (all cross-module imports are types,
// erased at compile time, so nothing pulls node:dns into a client bundle).
// The cron (/api/cron/check-inbox-health) gathers the inputs (DNS, Spamhaus
// DBL, native_sends bounce stats) and calls this.
//
// Model: start at 100, subtract a fixed penalty per unhealthy signal. A signal
// we couldn't measure (no data, sample too small, no key) is reported as
// "unchecked" with a zero penalty: never guessed, never punished. So a
// brand-new mailbox with good DNS and no send/warmup history scores 100 with
// several "unchecked" rows visible, rather than being dinged for missing data.
//
// Bands mirror the client-health badge convention (src/lib/kpi/definitions.ts):
//   healthy  score >= 80   (badge-green)
//   watch    50–79         (badge-amber)
//   critical < 50          (badge-red)
//
// Penalty weights (single source of truth, the table below is the spec):
//   blacklist (DBL listed)                         -60
//   SPF        fail -15 / warn -5
//   DKIM       fail -15 / warn -5   (check.ts only ever warns for DKIM)
//   DMARC      fail -10 / warn -5   (fail = record missing; warn = p=none,
//                                    monitoring-only, no spoofing enforcement)
//   MX         fail -20
//   bounce 7d      >10% -60 / 5–10% -40 / 2–5% -15   (only when >= 20 sends)
//   soft bounce 7d >25% -15 / 10–25% -8   (warn-only; transient, never critical
//                                          on its own; only when >= 20 sends)
//   reply signal   0 replies over >= 40 sends/14d  -10  (warn-only; a dead reply
//                  rate at real volume is the cheapest inbox-placement proxy)
//   seed placement spam >= 50% of seeds -45 / any spam -25 / any missing -10 /
//                  Promotions majority -5   (latest COMPLETE placement test no
//                  older than PLACEMENT_FRESHNESS_DAYS; older or none = unchecked)
//
// Bounce/soft-bounce/reply are *behavioral* signals: everything above them is
// a config/DNS check that only moves when you edit DNS or get blacklisted, which
// is why a correctly-configured mailbox otherwise sits at 100 indefinitely.
// Seed placement is the one DIRECT measurement: a probe sent to inboxes we
// control and read back via the Gmail API (see ./placement.ts). Its detail
// also carries the receiver-side SPF/DKIM/DMARC verdicts, which is what turns
// "the score dipped" into "why": auth failure vs. reputation/content.
//
// Sanity anchors (used by scripts/test-inbox-health.ts): perfect = 100/healthy;
// DBL-listed alone = 40/critical; >10% bounces alone = 40/critical; a total DNS
// resolver outage (SPF fail + DKIM warn + DMARC fail + MX fail) = exactly
// 50/watch; 2 of 3 seeds in spam alone = 55/watch; empty inputs = 100/healthy
// with every component "unchecked".

import type { HealthBand, HealthComponent, PlacementAuthSummary } from "@/types/app";
import type { AuthCheck, DomainAuth } from "./check";
import type { DblResult } from "./dnsbl";
import { PLACEMENT_FRESHNESS_DAYS, describeAuthFailures, describeCounts } from "./placement";

export const HEALTHY_MIN = 80;
export const CRITICAL_MAX = 49; // score <= 49 is critical (i.e. below 50)
export const MIN_SENT_FOR_BOUNCE_SCORE = 20; // mirrors kpi/step-health MIN_SENT_FOR_ALERT
// Reply signal needs more volume than bounce rate before a zero-reply run is
// meaningful: cold-email reply rates are low (~1–5%), so at small samples a
// zero is just noise. 40 sends over 14 days is the floor below which we say
// nothing (component reads "unchecked").
export const MIN_SENT_FOR_REPLY_SIGNAL = 40;

export interface InboxHealthInputs {
  /** Spamhaus DBL result. null/undefined → blacklist via DBL not checked. */
  dbl?: DblResult | null;
  /** SPF/DKIM/DMARC from checkDomainAuth. null → those three unchecked. */
  domainAuth?: DomainAuth | null;
  /** MX from checkMx. null → MX unchecked. */
  mx?: AuthCheck | null;
  /**
   * 7-day send/bounce counts from native_sends. null → bounce rate unchecked.
   * softBounced7d is optional: absent → soft-bounce signal unchecked even when
   * the hard-bounce rate is scored (lets old callers omit it).
   */
  bounces?: { sent7d: number; bounced7d: number; softBounced7d?: number } | null;
  /**
   * 14-day send + reply counts for this mailbox. sent14d from native_sends,
   * replied14d from lead_replies (native_email). null → reply signal unchecked.
   */
  replies?: { sent14d: number; replied14d: number } | null;
  /**
   * Latest COMPLETE seed placement test for this mailbox, already filtered to
   * <= PLACEMENT_FRESHNESS_DAYS old by the caller. null → seed placement
   * unchecked (never "no placement").
   */
  placement?: PlacementSignal | null;
}

// The scorer's view of one completed placement test (built from a
// placement_tests row by placementSignalFromTest in ./placement-runner.ts).
export interface PlacementSignal {
  testedAt: string; // ISO
  probe: "neutral" | "campaign";
  seedsTotal: number;
  inbox: number;
  promotions: number;
  spam: number;
  /** missing + bounced + other */
  missing: number;
  authSummary?: PlacementAuthSummary | null;
}

export interface InboxHealthResult {
  score: number; // clamped 0–100
  band: HealthBand;
  components: HealthComponent[]; // all 9, always, in fixed order
}

export function computeInboxHealth(inputs: InboxHealthInputs): InboxHealthResult {
  const { dbl, domainAuth, mx, bounces, replies, placement } = inputs;

  const components: HealthComponent[] = [
    blacklistComponent(dbl),
    authComponent("spf", "SPF", domainAuth?.spf, { fail: 15, warn: 5 }, "SPF not checked."),
    authComponent("dkim", "DKIM", domainAuth?.dkim, { fail: 15, warn: 5 }, "DKIM not checked."),
    authComponent("dmarc", "DMARC", domainAuth?.dmarc, { fail: 10, warn: 5 }, "DMARC not checked."),
    authComponent("mx", "MX records", mx, { fail: 20, warn: 10 }, "MX not checked."),
    bounceComponent(bounces),
    softBounceComponent(bounces),
    replySignalComponent(replies),
    seedPlacementComponent(placement),
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
 * One-line, plain-language summary of what's wrong: the `detail` of every
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
      detail: `Only ${sent} send${sent === 1 ? "" : "s"} in the last 7 days, need ${MIN_SENT_FOR_BOUNCE_SCORE} to score bounce rate.`,
    };
  }
  const rate = bounces.bounced7d / bounces.sent7d;
  const detail = `${bounces.bounced7d} of ${bounces.sent7d} sends bounced this week (${(rate * 100).toFixed(1)}%).`;
  if (rate > 0.1) return { key, label, status: "bad", deduction: 60, detail };
  if (rate > 0.05) return { key, label, status: "bad", deduction: 40, detail };
  if (rate > 0.02) return { key, label, status: "warn", deduction: 15, detail };
  return { key, label, status: "ok", deduction: 0, detail };
}

/**
 * Soft (transient, 4.x.x) bounce rate over the last 7 days. Warn-only by
 * design: a soft bounce is a temporary failure Gmail retries on its own, so it
 * never suppresses a contact and never alone drives a mailbox critical. But a
 * *rising* soft-bounce rate is an early throttling / greylisting signal: the
 * receiving side deferring our mail: worth a small nudge before it turns into
 * hard bounces or spam-foldering. Same >= 20-send floor as the hard-bounce
 * component; unchecked below it or when softBounced7d wasn't supplied.
 */
function softBounceComponent(
  bounces: { sent7d: number; bounced7d: number; softBounced7d?: number } | null | undefined,
): HealthComponent {
  const key: HealthComponent["key"] = "soft_bounce_rate";
  const label = "Soft-bounce rate (7 days)";
  const soft = bounces?.softBounced7d;
  const sent = bounces?.sent7d ?? 0;
  if (!bounces || soft == null || sent < MIN_SENT_FOR_BOUNCE_SCORE) {
    return {
      key,
      label,
      status: "unchecked",
      deduction: 0,
      detail:
        soft == null
          ? "Soft-bounce rate not measured."
          : `Only ${sent} send${sent === 1 ? "" : "s"} in the last 7 days, need ${MIN_SENT_FOR_BOUNCE_SCORE} to score soft-bounce rate.`,
    };
  }
  const rate = soft / sent;
  const detail = `${soft} of ${sent} sends soft-bounced this week (${(rate * 100).toFixed(1)}%): transient, not suppressed.`;
  if (rate > 0.25) return { key, label, status: "warn", deduction: 15, detail };
  if (rate > 0.1) return { key, label, status: "warn", deduction: 8, detail };
  return { key, label, status: "ok", deduction: 0, detail };
}

/**
 * Reply signal over the last 14 days: the first component that reflects how
 * recipients *respond*, not how the domain is configured. Rationale: at steady
 * sending volume, a reply rate that collapses to zero is the cheapest available
 * proxy for landing in spam (mail that reaches a real inbox eventually draws
 * replies, OOO auto-responders included; mail that spam-folders draws none).
 *
 * Deliberately conservative to avoid false alarms: warn-only, never critical;
 * unchecked below MIN_SENT_FOR_REPLY_SIGNAL sends (a zero at low volume is
 * noise); and it only fires on an *absolute zero*: any reply at all reads ok.
 * It does not score reply-rate deltas, which are too noisy at these volumes.
 */
function replySignalComponent(
  replies: { sent14d: number; replied14d: number } | null | undefined,
): HealthComponent {
  const key: HealthComponent["key"] = "reply_signal";
  const label = "Reply signal (14 days)";
  const sent = replies?.sent14d ?? 0;
  if (!replies || sent < MIN_SENT_FOR_REPLY_SIGNAL) {
    return {
      key,
      label,
      status: "unchecked",
      deduction: 0,
      detail: `Only ${sent} send${sent === 1 ? "" : "s"} in the last 14 days, need ${MIN_SENT_FOR_REPLY_SIGNAL} to read the reply signal.`,
    };
  }
  if (replies.replied14d === 0) {
    return {
      key,
      label,
      status: "warn",
      deduction: 10,
      detail: `No replies across ${sent} sends in 14 days, possible inbox-placement issue (check seed/placement before scaling this mailbox).`,
    };
  }
  const rate = replies.replied14d / replies.sent14d;
  return {
    key,
    label,
    status: "ok",
    deduction: 0,
    detail: `${replies.replied14d} repl${replies.replied14d === 1 ? "y" : "ies"} across ${sent} sends in 14 days (${(rate * 100).toFixed(1)}%).`,
  };
}

/**
 * Seed placement: the only component that measures where mail lands rather
 * than inferring it. Graded on the latest complete test's seed outcomes:
 * spam is graded hardest (it is the thing every other signal is a proxy for),
 * "missing" softer (a gateway rejection or a delay, ambiguous until re-run),
 * and a Promotions majority lightest (delivered, but read as marketing). The
 * detail names the receiver-side SPF/DKIM/DMARC verdicts so the operator can
 * tell an authentication problem from a reputation/content one at a glance.
 * Deliberately sized so that a bad panel alone lands in "watch", not
 * "critical": a 3–5 seed panel is a strong hint, not a verdict, critical
 * needs corroboration from bounces, blacklist, or DNS.
 */
function seedPlacementComponent(p: PlacementSignal | null | undefined): HealthComponent {
  const key: HealthComponent["key"] = "seed_placement";
  const label = "Seed placement";
  if (!p) {
    return {
      key,
      label,
      status: "unchecked",
      deduction: 0,
      detail: `No placement test in the last ${PLACEMENT_FRESHNESS_DAYS} days, run one from Mailboxes → Seed inboxes to measure where this mailbox actually lands.`,
    };
  }
  const total = p.inbox + p.promotions + p.spam + p.missing;
  if (total === 0) {
    return {
      key,
      label,
      status: "unchecked",
      deduction: 0,
      detail: "The last placement test had no readable seeds, check the seed panel and re-run.",
    };
  }
  const when = new Date(p.testedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const probeLabel = p.probe === "campaign" ? "campaign copy" : "neutral probe";
  const summary = `${describeCounts({ total, inbox: p.inbox, promotions: p.promotions, spam: p.spam, missing: p.missing })} on ${when} (${probeLabel}).`;
  const authFailures = describeAuthFailures(p.authSummary);
  const authNote = authFailures
    ? ` Receiver-side auth: ${authFailures}, fix authentication before anything else.`
    : p.authSummary && p.authSummary.checked > 0
      ? " Receiver-side SPF/DKIM/DMARC passed, so this is reputation or content, not authentication."
      : "";

  if (p.spam > 0 && p.spam / total >= 0.5) {
    return { key, label, status: "bad", deduction: 45, detail: `${summary}${authNote}` };
  }
  if (p.spam > 0) {
    return { key, label, status: "bad", deduction: 25, detail: `${summary}${authNote}` };
  }
  if (p.missing > 0) {
    return {
      key,
      label,
      status: "warn",
      deduction: 10,
      detail: `${summary} A missing probe usually means a gateway rejection or a delay, re-run before acting on it.${authNote}`,
    };
  }
  if (p.promotions > p.inbox) {
    return {
      key,
      label,
      status: "warn",
      deduction: 5,
      detail: `${summary} Most seeds filed it under Promotions, Gmail reads the message as marketing; try a plainer, more personal first line.`,
    };
  }
  return { key, label, status: "ok", deduction: 0, detail: `${summary}${authNote}` };
}
