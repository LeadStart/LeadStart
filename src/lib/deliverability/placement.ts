// Inbox-placement testing — the PURE half (no I/O). Classification of where a
// probe landed, receiver-side auth parsing, probe copy, and result roll-ups.
// The I/O half (sending probes, reading seed inboxes, persisting) lives in
// ./placement-runner.ts; the health scorer (./inbox-health.ts) consumes the
// roll-up this module produces. Keeping this file import-free of node:* and
// Supabase means the admin page can import the display helpers and the unit
// test (scripts/test-placement.ts) can exercise every branch without a DB.
//
// How a placement test works (see migration 00068 for the data model):
//   1. Send one short probe from the sending mailbox to each seed inbox on a
//      DIFFERENT domain (same-tenant delivery is never filtered, so a same-
//      domain seed would only ever read "inbox" and teach us nothing).
//   2. After a short delay, search each seed for the probe's Message-ID
//      (Gmail `rfc822msgid:` operator, spam included) and read its labelIds
//      plus the receiver's Authentication-Results header.
//   3. Roll the per-seed outcomes up into counts the health scorer grades.
//
// Probes are never logged to native_sends (not campaign mail), and no seed is
// ever mutated (the delegation scope is gmail.readonly) — this is measurement,
// not a warmup game. See memory: project_no_warmup_pool_deliberate.

import type {
  PlacementAuthResults,
  PlacementAuthSummary,
  PlacementResultStatus,
} from "@/types/app";

// Don't look for a probe sooner than this after sending — cross-tenant Gmail
// delivery is usually seconds, but the spam verdict is attached on delivery and
// an early read of a not-yet-delivered message just wastes a Gmail call.
export const PLACEMENT_CHECK_DELAY_MS = 45_000;
// After this long, a probe that still isn't in the seed is declared missing
// (blocked at the gateway, or bounced — the runner checks for a DSN first).
export const PLACEMENT_TIMEOUT_MS = 30 * 60_000;
// A placement result older than this no longer informs the health score.
export const PLACEMENT_FRESHNESS_DAYS = 7;
// Bound the sends one run can cost: with a 20/day ramp ceiling per mailbox a
// panel larger than this is volume we'd rather spend on real prospects.
export const MAX_SEEDS_PER_TEST = 10;

// ── Folder classification ───────────────────────────────────────────────

/**
 * Map the Gmail labelIds observed on the delivered probe to a placement
 * bucket. Gmail attaches exactly one CATEGORY_* label to inbox mail even when
 * the user has tabs switched off (typical for Workspace), so "promotions" is
 * still a real verdict about how the filter read the message.
 */
export function classifyPlacement(
  labelIds: readonly string[] | null | undefined,
): Extract<PlacementResultStatus, "inbox" | "promotions" | "spam" | "other"> {
  const labels = new Set(labelIds ?? []);
  if (labels.has("SPAM")) return "spam";
  if (labels.has("INBOX")) {
    return labels.has("CATEGORY_PROMOTIONS") ? "promotions" : "inbox";
  }
  // Present in the mailbox but not in the inbox: archived by a user filter,
  // trashed, etc. Counted against placement but labelled distinctly.
  return "other";
}

/** Gmail's rfc822msgid: operator wants the id without the angle brackets. */
export function stripMessageIdBrackets(messageId: string): string {
  return messageId.trim().replace(/^<|>$/g, "");
}

// ── Receiver-side authentication ────────────────────────────────────────

/**
 * Parse a Gmail Authentication-Results (or ARC-Authentication-Results)
 * header into the three verdicts we care about. The header looks like:
 *   mx.google.com; dkim=pass header.i=@example.com ...; spf=pass ...; dmarc=pass ...
 * We keep the first verdict per mechanism (later ones are for secondary
 * signatures) and the raw header (truncated) for the detail view.
 */
export function parseAuthenticationResults(
  header: string | null | undefined,
): PlacementAuthResults {
  const out: PlacementAuthResults = { spf: null, dkim: null, dmarc: null, raw: null };
  if (!header) return out;
  out.raw = header.length > 600 ? `${header.slice(0, 600)}…` : header;
  const re = /\b(spf|dkim|dmarc)=([a-z]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    const key = m[1].toLowerCase() as "spf" | "dkim" | "dmarc";
    if (out[key] == null) out[key] = m[2].toLowerCase();
  }
  return out;
}

/** A verdict we'd call a failure (anything that isn't pass/none/neutral). */
export function isAuthFailure(verdict: string | null | undefined): boolean {
  if (!verdict) return false;
  return !["pass", "none", "neutral", "bestguesspass"].includes(verdict);
}

// ── Roll-ups ────────────────────────────────────────────────────────────

export interface PlacementCounts {
  /** Readable seeds — everything except send_failed / unreadable. */
  total: number;
  inbox: number;
  promotions: number;
  spam: number;
  /** missing + bounced + other. */
  missing: number;
  pending: number;
  /** Seeds excluded from total (send_failed / unreadable). */
  excluded: number;
}

export function summarizeResults(
  results: readonly { status: PlacementResultStatus }[],
): PlacementCounts {
  const c: PlacementCounts = {
    total: 0,
    inbox: 0,
    promotions: 0,
    spam: 0,
    missing: 0,
    pending: 0,
    excluded: 0,
  };
  for (const r of results) {
    switch (r.status) {
      case "send_failed":
      case "unreadable":
        c.excluded += 1;
        continue;
      case "pending":
        c.pending += 1;
        break;
      case "inbox":
        c.inbox += 1;
        break;
      case "promotions":
        c.promotions += 1;
        break;
      case "spam":
        c.spam += 1;
        break;
      case "missing":
      case "bounced":
      case "other":
        c.missing += 1;
        break;
    }
    c.total += 1;
  }
  return c;
}

export function summarizeAuth(
  results: readonly { auth_results: PlacementAuthResults | null }[],
): PlacementAuthSummary {
  const s: PlacementAuthSummary = { checked: 0, spf_fail: 0, dkim_fail: 0, dmarc_fail: 0 };
  for (const r of results) {
    const a = r.auth_results;
    if (!a || (a.spf == null && a.dkim == null && a.dmarc == null)) continue;
    s.checked += 1;
    if (isAuthFailure(a.spf)) s.spf_fail += 1;
    if (isAuthFailure(a.dkim)) s.dkim_fail += 1;
    if (isAuthFailure(a.dmarc)) s.dmarc_fail += 1;
  }
  return s;
}

/** "dkim failed at 2 of 3 seeds" / "" when nothing failed or nothing checked. */
export function describeAuthFailures(s: PlacementAuthSummary | null | undefined): string {
  if (!s || s.checked === 0) return "";
  const parts: string[] = [];
  if (s.spf_fail > 0) parts.push(`SPF failed at ${s.spf_fail} of ${s.checked}`);
  if (s.dkim_fail > 0) parts.push(`DKIM failed at ${s.dkim_fail} of ${s.checked}`);
  if (s.dmarc_fail > 0) parts.push(`DMARC failed at ${s.dmarc_fail} of ${s.checked}`);
  return parts.join(", ");
}

// ── Probe copy ──────────────────────────────────────────────────────────

export interface ProbeCopy {
  subject: string;
  bodyText: string;
}

// A small pool so a weekly run to the same panel isn't byte-identical every
// time (near-duplicate mail to the same recipients is itself a bulk signal).
// Deliberately shaped like the 1:1 B2B notes the channel actually sends:
// short, plain, no links, no images, a signature — so the verdict reflects the
// domain/mailbox reputation and auth rather than the probe's own content.
const NEUTRAL_PROBES: { subject: string; body: (name: string) => string }[] = [
  {
    subject: "quick question",
    body: (name) =>
      `Hi there,\n\nHope your week is going well. I wanted to see whether you'd have a few minutes this week or next to talk through what you're working on — happy to work around your schedule.\n\nIf now isn't a good time, just let me know and I'll check back later.\n\nBest,\n${name}`,
  },
  {
    subject: "following up",
    body: (name) =>
      `Hi,\n\nJust following up on my note from earlier — no rush at all. If it would be useful, I can send over a short summary of what I had in mind so you can see whether it's relevant.\n\nEither way, thanks for your time.\n\n${name}`,
  },
  {
    subject: "checking in",
    body: (name) =>
      `Hi there,\n\nChecking in to see if you had a chance to look at this. I know things get busy, so if it's easier I can call at a time that suits you.\n\nLet me know what works.\n\nThanks,\n${name}`,
  },
  {
    subject: "a quick thought",
    body: (name) =>
      `Hi,\n\nI had a quick thought after looking at what you've been up to recently and figured it was worth a short note. Would you be open to a ten-minute call sometime next week?\n\nIf not, no problem — I appreciate you reading this.\n\nKind regards,\n${name}`,
  },
];

/**
 * Build a neutral probe. `variant` picks from the pool (any integer; wrapped),
 * so the runner can rotate by test rather than by Math.random in a cron.
 */
export function buildNeutralProbe(params: {
  senderName: string;
  variant?: number;
}): ProbeCopy {
  const n = NEUTRAL_PROBES.length;
  const i = ((Math.floor(params.variant ?? 0) % n) + n) % n;
  const p = NEUTRAL_PROBES[i];
  return { subject: p.subject, bodyText: p.body(params.senderName) };
}

export const NEUTRAL_PROBE_COUNT = NEUTRAL_PROBES.length;

// ── Display helpers (shared by the admin UI and the health detail) ───────

export function placementStatusLabel(status: PlacementResultStatus): string {
  switch (status) {
    case "pending":
      return "Checking…";
    case "inbox":
      return "Inbox";
    case "promotions":
      return "Promotions";
    case "spam":
      return "Spam";
    case "other":
      return "Not in inbox";
    case "missing":
      return "Missing";
    case "bounced":
      return "Bounced";
    case "send_failed":
      return "Send failed";
    case "unreadable":
      return "Seed unreadable";
  }
}

/**
 * One-line summary of a completed run, e.g. "3 of 3 seeds in the inbox",
 * "2 of 3 seeds in spam (1 inbox)", "1 of 2 seeds missing (1 inbox)".
 */
export function describeCounts(c: {
  total: number;
  inbox: number;
  promotions: number;
  spam: number;
  missing: number;
}): string {
  if (c.total === 0) return "No readable seeds";
  const delivered = c.inbox + c.promotions;
  const rest: string[] = [];
  if (c.promotions > 0) rest.push(`${c.promotions} in Promotions`);
  if (c.spam > 0 && c.spam !== c.total) rest.push(`${c.spam} spam`);
  if (c.missing > 0 && c.missing !== c.total) rest.push(`${c.missing} missing`);
  if (c.spam > 0) {
    const others = [
      delivered > 0 ? `${delivered} inbox` : null,
      c.missing > 0 ? `${c.missing} missing` : null,
    ].filter(Boolean);
    return `${c.spam} of ${c.total} seed${c.total === 1 ? "" : "s"} in spam${others.length ? ` (${others.join(", ")})` : ""}`;
  }
  if (c.missing > 0) {
    return `${c.missing} of ${c.total} seed${c.total === 1 ? "" : "s"} missing${delivered > 0 ? ` (${delivered} inbox)` : ""}`;
  }
  return `${delivered} of ${c.total} seed${c.total === 1 ? "" : "s"} in the inbox${rest.length ? ` (${rest.join(", ")})` : ""}`;
}
