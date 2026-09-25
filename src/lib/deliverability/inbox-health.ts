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
//   reply rate (per contact, the app's definition; see ./engagement.ts) for
//                  the mailbox's DOMAIN: its contacts first emailed 14–42 days
//                  ago vs. the org's contacts first emailed before that, each
//                  judged on replies within 14 days of the first email. A drop
//                  to <= 50% of the earlier rate that's < 5% likely by chance
//                  -10 (warn); to <= 25% and < 0.1% likely -25 (bad).
//                  Unchecked below 50 recent / 100 earlier contacts.
//   opt-out rate   same recent contacts: > 2% asked to be removed within 14
//                  days (and >= 3 of them) -10 (warn-only). The closest visible
//                  proxy for spam complaints.
//   seed placement spam >= 50% of seeds -45 / any spam -25 / any missing -10 /
//                  Promotions majority -5   (latest COMPLETE placement test no
//                  older than PLACEMENT_FRESHNESS_DAYS; older or none = unchecked)
//
// Bounce/soft-bounce/reply/opt-out are *behavioral* signals: everything above them is
// a config/DNS check that only moves when you edit DNS or get blacklisted, which
// is why a correctly-configured mailbox otherwise sits at 100 indefinitely.
// Seed placement is the one DIRECT measurement: a probe sent to inboxes we
// control and read back via the Gmail API (see ./placement.ts). Its detail
// also carries the receiver-side SPF/DKIM/DMARC verdicts, which is what turns
// "the score dipped" into "why": auth failure vs. reputation/content.
//
// Sanity anchors (used by scripts/test-inbox-health.ts): perfect = 100/healthy;
// DBL-listed alone = 40/critical; >10% bounces alone = 40/critical; SPF, DMARC
// and MX genuinely missing (+ DKIM warn) = exactly 50/watch; a DNS resolver
// OUTAGE (every lookup "unknown") = 100, all four unchecked; 2 of 3 seeds in
// spam alone = 55/watch; empty inputs = 100/healthy, every component unchecked.

import type { HealthBand, HealthComponent, PlacementAuthSummary } from "@/types/app";
import type { AuthCheck, DomainAuth } from "./check";
import type { DblResult } from "./dnsbl";
import { PLACEMENT_FRESHNESS_DAYS, describeAuthFailures, describeCounts } from "./placement";
import { ENGAGEMENT_EXPOSURE_DAYS, poissonCdf, type ContactEngagement } from "./engagement";

export const HEALTHY_MIN = 80;
export const CRITICAL_MAX = 49; // score <= 49 is critical (i.e. below 50)
export const MIN_SENT_FOR_BOUNCE_SCORE = 20; // mirrors kpi/step-health MIN_SENT_FOR_ALERT

// Reply + opt-out signals (per contact; see ./engagement.ts for the windows).
// Sample floors: below these a rate says nothing either way.
export const MIN_RECENT_CONTACTS = 50;
export const MIN_BASELINE_CONTACTS = 100;
// A reply-rate drop is flagged only when it is BOTH large (the recent rate is
// at most this share of the earlier one) and unlikely to be chance (Poisson
// lower tail below this probability): a small dip on a big sample, or a big
// dip on a tiny one, stays ok.
export const REPLY_DROP_WARN = { maxShare: 0.5, maxChance: 0.05 } as const;
export const REPLY_DROP_BAD = { maxShare: 0.25, maxChance: 0.001 } as const;
// Opt-out replies are the closest visible proxy for spam complaints (Gmail
// reports no complaints at this volume). A heuristic line, not a published
// threshold: > 2% of new contacts asking to be removed within 14 days.
export const OPTOUT_WARN_RATE = 0.02;
export const OPTOUT_MIN_COUNT = 3;

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
   * Per-contact engagement for this mailbox's DOMAIN (computeContactEngagement
   * in ./engagement.ts): its recent contacts vs. the org's earlier ones.
   * null → reply-rate and opt-out signals unchecked (never "no replies").
   */
  engagement?: ContactEngagement | null;
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
  components: HealthComponent[]; // all 10, always, in fixed order
}

export function computeInboxHealth(inputs: InboxHealthInputs): InboxHealthResult {
  const { dbl, domainAuth, mx, bounces, engagement, placement } = inputs;

  const components: HealthComponent[] = [
    blacklistComponent(dbl),
    authComponent("spf", "SPF", domainAuth?.spf, { fail: 15, warn: 5 }, "SPF not checked."),
    authComponent("dkim", "DKIM", domainAuth?.dkim, { fail: 15, warn: 5 }, "DKIM not checked."),
    authComponent("dmarc", "DMARC", domainAuth?.dmarc, { fail: 10, warn: 5 }, "DMARC not checked."),
    authComponent("mx", "MX records", mx, { fail: 20, warn: 10 }, "MX not checked."),
    bounceComponent(bounces),
    softBounceComponent(bounces),
    replyRateComponent(engagement),
    optOutComponent(engagement),
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
  // The lookup failed (timeout / SERVFAIL), so existence is unknown: a DNS
  // hiccup must never read as a missing record (see lookup() in ./check.ts).
  if (check.status === "unknown") return { key, label, status: "unchecked", deduction: 0, detail: check.detail };
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

const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.01 ? 2 : 1)}%`;
const chanceText = (p: number) =>
  p < 0.001 ? "less than 0.1%" : p < 0.01 ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`;
function cohortPhrase(e: ContactEngagement): string {
  const d = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `contacts first emailed from ${e.domain} ${d(e.cohortFrom)}–${d(e.cohortTo)}`;
}

/**
 * Reply rate per contact (the app's definition) for the mailbox's DOMAIN: the
 * behavioral signal for "is our mail still being seen". Reputation is judged
 * per domain, and a single inbox's contacts are too few to read, so every
 * mailbox on the domain carries the same verdict (like DNS and the blacklist).
 *
 * Compares the domain's recent contacts with the org's earlier ones on the
 * same 14-day exposure, and flags a drop only when it is both large and
 * unlikely to be chance. The detail pairs it with opt-outs: when opt-outs fall
 * along with replies, people most likely aren't seeing the emails; when they
 * hold or rise, targeting or copy is the likelier cause. A relative baseline
 * can't see a problem that was already there in the baseline period; seed
 * placement is the direct measurement for that.
 */
function replyRateComponent(e: ContactEngagement | null | undefined): HealthComponent {
  const key: HealthComponent["key"] = "reply_signal";
  const label = `Reply rate per contact (${ENGAGEMENT_EXPOSURE_DAYS} days)`;
  if (!e) {
    return { key, label, status: "unchecked", deduction: 0, detail: "Reply rate not measured." };
  }
  const { recent, baseline } = e;
  const who = cohortPhrase(e);
  if (recent.contacts < MIN_RECENT_CONTACTS) {
    return {
      key,
      label,
      status: "unchecked",
      deduction: 0,
      detail: `${recent.contacts} ${who}; need ${MIN_RECENT_CONTACTS} to judge the reply rate.`,
    };
  }
  const rate = recent.replied / recent.contacts;
  const summary = `${recent.replied} of ${recent.contacts} ${who} replied within ${ENGAGEMENT_EXPOSURE_DAYS} days (${pct(rate)})`;
  if (baseline.contacts < MIN_BASELINE_CONTACTS || baseline.replied === 0) {
    return {
      key,
      label,
      status: "unchecked",
      deduction: 0,
      detail: `${summary}. Not enough earlier contacts${baseline.contacts >= MIN_BASELINE_CONTACTS ? " with replies" : ""} to compare against yet.`,
    };
  }
  const p0 = baseline.replied / baseline.contacts;
  const chance = poissonCdf(recent.replied, recent.contacts * p0);
  const share = rate / p0;
  const vs = `${summary}, vs ${pct(p0)} for the org's contacts emailed before that`;

  const q0 = baseline.optedOut / baseline.contacts;
  const q = recent.optedOut / recent.contacts;
  const optOutNote =
    q0 > 0 && q <= q0 / 2
      ? ` Opt-outs fell too (${pct(q0)} → ${pct(q)}), which usually means people aren't seeing the emails rather than losing interest.`
      : q >= q0 && recent.optedOut > 0
        ? ` Opt-outs held up (${pct(q0)} → ${pct(q)}), which points more to targeting or copy than to the spam folder.`
        : "";

  if (share <= REPLY_DROP_BAD.maxShare && chance < REPLY_DROP_BAD.maxChance) {
    return {
      key,
      label,
      status: "bad",
      deduction: 25,
      detail: `${vs}. A drop this large happens by chance ${chanceText(chance)} of the time.${optOutNote} Consider resting this domain before it burns.`,
    };
  }
  if (share <= REPLY_DROP_WARN.maxShare && chance < REPLY_DROP_WARN.maxChance) {
    return {
      key,
      label,
      status: "warn",
      deduction: 10,
      detail: `${vs}. A drop this large happens by chance ${chanceText(chance)} of the time.${optOutNote}`,
    };
  }
  return { key, label, status: "ok", deduction: 0, detail: `${vs}.` };
}

/**
 * Opt-out rate per contact for the mailbox's DOMAIN: people who replied asking
 * to be removed within 14 days of their first email. Gmail reports no spam
 * complaints at this volume, and complaints are what drag a domain's
 * reputation down; opt-out replies are the closest visible proxy. Warn-only:
 * the link between the two is real but unmeasured, so this nudges rather than
 * pauses.
 */
function optOutComponent(e: ContactEngagement | null | undefined): HealthComponent {
  const key: HealthComponent["key"] = "optout_rate";
  const label = `Opt-out rate per contact (${ENGAGEMENT_EXPOSURE_DAYS} days)`;
  if (!e) {
    return { key, label, status: "unchecked", deduction: 0, detail: "Opt-out rate not measured." };
  }
  const { recent } = e;
  const who = cohortPhrase(e);
  if (recent.contacts < MIN_RECENT_CONTACTS) {
    return {
      key,
      label,
      status: "unchecked",
      deduction: 0,
      detail: `${recent.contacts} ${who}; need ${MIN_RECENT_CONTACTS} to judge the opt-out rate.`,
    };
  }
  const q = recent.optedOut / recent.contacts;
  const summary = `${recent.optedOut} of ${recent.contacts} ${who} asked to be removed within ${ENGAGEMENT_EXPOSURE_DAYS} days (${pct(q)})`;
  if (recent.optedOut >= OPTOUT_MIN_COUNT && q > OPTOUT_WARN_RATE) {
    return {
      key,
      label,
      status: "warn",
      deduction: 10,
      detail: `${summary}. That's high: opt-out replies are the closest visible sign of spam complaints, which are what drag a domain's reputation down. Check the targeting and the first two steps' copy.`,
    };
  }
  return { key, label, status: "ok", deduction: 0, detail: `${summary}.` };
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
