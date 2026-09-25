// Per-contact engagement behind the inbox-health reply + opt-out signals.
//
// Same definition as the app's headline reply rate (src/lib/kpi/calculator.ts +
// computeCohortReplies in src/lib/kpi/cohort.ts): a contact is identified by
// email, attributed to their FIRST email (earliest step-0 send), and counts as
// a replier on any native reply (the caller leaves out excluded_from_stats
// rows, as sync-analytics does). An opt-out is a reply classified
// 'unsubscribe', the app's unsubscribe metric.
//
// One addition, needed to compare groups of contacts fairly: every contact
// gets the SAME exposure. A contact counts as replied (or opted out) only if
// it happened within ENGAGEMENT_EXPOSURE_DAYS of their first email, and only
// contacts first emailed at least that long ago are counted, so a young group
// never reads as "no replies yet".
//
//   recent    contacts first emailed from THIS domain in the COHORT window
//             (14 to 42 days ago)
//   baseline  contacts first emailed from ANY of the org's domains in the
//             BASELINE window before that (42 to 132 days ago)
//
// Comparing a domain's recent contacts with the org's earlier ones is what
// exposes a slide like August 2026 (the same list replied at 5.8% when first
// emailed in July and 0.9% in August; davidcabreraproperties.com 0.3%).
//
// Pure: the health cron passes rows in; no I/O here.

export const ENGAGEMENT_EXPOSURE_DAYS = 14;
export const ENGAGEMENT_COHORT_DAYS = 28;
export const ENGAGEMENT_BASELINE_DAYS = 90;
const DAY_MS = 86_400_000;

/** How far back the caller must read step-0 sends and replies. */
export const ENGAGEMENT_LOOKBACK_DAYS =
  ENGAGEMENT_EXPOSURE_DAYS + ENGAGEMENT_COHORT_DAYS + ENGAGEMENT_BASELINE_DAYS;

export interface FirstTouchRow {
  to_email: string | null;
  sent_at: string | null;
  /** Sending domain of the mailbox that sent this step-0 email. */
  domain: string;
}

export interface EngagementReplyRow {
  lead_email: string | null;
  received_at: string | null;
  final_class: string | null;
}

export interface EngagementCounts {
  contacts: number;
  replied: number;
  optedOut: number;
}

export interface ContactEngagement {
  domain: string;
  /** First-email window of the recent group (YYYY-MM-DD, inclusive). */
  cohortFrom: string;
  cohortTo: string;
  recent: EngagementCounts;
  baseline: EngagementCounts;
}

/**
 * Build the per-domain engagement for one organization. Pass ONLY that org's
 * step-0 sends and its native replies received within ENGAGEMENT_LOOKBACK_DAYS.
 * Returns an accessor so every domain gets a result (zeros when it emailed
 * no one in the window).
 */
export function computeContactEngagement(
  firstTouches: FirstTouchRow[],
  replies: EngagementReplyRow[],
  now: number,
): (domain: string) => ContactEngagement {
  const exposureMs = ENGAGEMENT_EXPOSURE_DAYS * DAY_MS;
  const recentEnd = now - exposureMs;
  const recentStart = recentEnd - ENGAGEMENT_COHORT_DAYS * DAY_MS;
  const baselineStart = recentStart - ENGAGEMENT_BASELINE_DAYS * DAY_MS;

  // Each contact's earliest first email (and the domain that sent it), as
  // computeCohortReplies does: re-enrolled contacts attribute to one first touch.
  const firstTouch = new Map<string, { at: number; domain: string }>();
  for (const s of firstTouches) {
    const email = s.to_email?.trim().toLowerCase();
    if (!email || !s.sent_at) continue;
    const at = Date.parse(s.sent_at);
    const cur = firstTouch.get(email);
    if (!cur || at < cur.at) firstTouch.set(email, { at, domain: s.domain.toLowerCase() });
  }

  // Each contact's earliest reply and earliest opt-out.
  const firstReply = new Map<string, number>();
  const firstOptOut = new Map<string, number>();
  for (const r of replies) {
    const email = r.lead_email?.trim().toLowerCase();
    if (!email || !r.received_at) continue;
    const at = Date.parse(r.received_at);
    if (at < (firstReply.get(email) ?? Infinity)) firstReply.set(email, at);
    if (r.final_class === "unsubscribe" && at < (firstOptOut.get(email) ?? Infinity)) {
      firstOptOut.set(email, at);
    }
  }
  const within = (event: number | undefined, first: number) =>
    event != null && event >= first && event - first <= exposureMs;

  const baseline: EngagementCounts = { contacts: 0, replied: 0, optedOut: 0 };
  const recentByDomain = new Map<string, EngagementCounts>();
  for (const [email, ft] of firstTouch) {
    if (ft.at >= recentEnd || ft.at < baselineStart) continue;
    let bucket = baseline;
    if (ft.at >= recentStart) {
      bucket = recentByDomain.get(ft.domain) ?? { contacts: 0, replied: 0, optedOut: 0 };
      recentByDomain.set(ft.domain, bucket);
    }
    bucket.contacts += 1;
    if (within(firstReply.get(email), ft.at)) bucket.replied += 1;
    if (within(firstOptOut.get(email), ft.at)) bucket.optedOut += 1;
  }

  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const cohortFrom = day(recentStart);
  const cohortTo = day(recentEnd - 1);
  return (domain: string) => ({
    domain: domain.toLowerCase(),
    cohortFrom,
    cohortTo,
    recent: { ...(recentByDomain.get(domain.toLowerCase()) ?? { contacts: 0, replied: 0, optedOut: 0 }) },
    baseline: { ...baseline },
  });
}

/**
 * P(X <= k) for X ~ Poisson(lambda), computed in log space so a large lambda
 * can't underflow to a false 0 ("impossibly low").
 */
export function poissonCdf(k: number, lambda: number): number {
  if (k < 0) return 0;
  if (lambda <= 0) return 1;
  const logLambda = Math.log(lambda);
  const logs: number[] = [];
  let logTerm = -lambda;
  logs.push(logTerm);
  for (let i = 1; i <= k; i++) {
    logTerm += logLambda - Math.log(i);
    logs.push(logTerm);
  }
  const maxLog = Math.max(...logs);
  const sum = logs.reduce((s, l) => s + Math.exp(l - maxLog), 0);
  return Math.min(1, Math.exp(maxLog) * sum);
}
