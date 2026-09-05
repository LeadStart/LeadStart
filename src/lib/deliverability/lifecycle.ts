// Sending-domain lifecycle rules: the burn-prevention state machine as pure
// logic. No I/O: given a domain's current lifecycle state, already-gathered
// signals, the clock, and its timers, decide the next state. The Phase 5
// lifecycle cron (manage-mailbox-lifecycle) gathers the inputs and applies the
// decision; this module is the single testable source of truth for WHEN a
// domain warms up, tires, rests, re-warms, or burns.
//
// The design goal is simple: rotate a domain out at "tired", before it is
// burned: rest it while its reputation decays back toward neutral, then
// re-warm and reuse it. A domain that reaches "burned" is a failure of this
// system, not a stage we plan to visit.
//
//   provisioning → warming → active → tired → resting → (re-)warming → active …
//                                       ↓         ↓
//                                    burned ← (still bad after a full rest)
//                                       ↓
//                                    retired (terminal)
//
// Plan + rationale: docs/plans/deliverability-infrastructure-plan.md §2.

import type {
  DomainLifecycle,
  HealthBand,
  HealthComponent,
  NativeMailbox,
  PlacementTest,
  SendingDomain,
} from "@/types/app";
import { rampStage } from "@/lib/gmail/ramp";

// ── Tunable constants (owner-chosen defaults; see plan §3) ──────────────────

// Days a domain stays in `resting` before it may re-warm. Long enough for
// reputation to decay toward neutral; the domain stays renewed with DNS/MX live
// so late replies still arrive. Owner-tunable 30–90.
export const REST_DAYS = 45;

// Days a `tired` domain drains in-flight follow-ups (intake already closed)
// before it goes fully `resting`. Sized to the longest realistic follow-up tail.
export const DRAIN_DAYS = 14;

// A domain cannot leave `warming` until its DNS has been live at least this long,
// regardless of ramp position: a young domain inboxes poorly no matter how
// gently it ramped.
export const MIN_DOMAIN_AGE_DAYS = 21;

// Consecutive daily health rollups in the `watch` band that tire an `active`
// domain. One bad day is noise; a sustained slide is a real reputation drift.
export const WATCH_STREAK_FOR_TIRED = 3;

// ── Fast bounce circuit breaker ─────────────────────────────────────────────
// Reacts faster than the hourly/daily health rollup: a burst of hard bounces
// means a poisoned list segment is actively torching the domain right now.

// Absolute count of hard bounces in the trailing 24h that trips the breaker.
export const CB_HARD_BOUNCES_24H = 3;
// …or a hard-bounce RATE above this over the most recent sample of sends.
export const CB_HARD_BOUNCE_RATE = 0.05;
// Minimum sample size before the rate form is trusted (a 1-in-3 start is noise).
export const CB_RATE_SAMPLE = 20;

// ── Send-eligibility helpers (read by the dispatcher) ───────────────────────

/**
 * Whether a domain accepts NEW step-0 enrollments. `tired` closes intake so
 * in-flight follow-ups can drain without new leads piling on; everything past
 * `active` is likewise closed. This is the ONLY lifecycle check the send
 * dispatcher applies, and only to the step-0 mailbox pool: sticky follow-ups
 * bypass it so a draining thread is never broken.
 */
export function domainOpenForNewLeads(status: DomainLifecycle): boolean {
  return status === "warming" || status === "active";
}

/**
 * Whether a domain may send AT ALL (including in-flight follow-ups). A `resting`
 * domain sends nothing, but that halt is enforced by the lifecycle cron pausing
 * its mailboxes (status='paused'), which the dispatcher's existing eligible()
 * already skips; this predicate is for callers reasoning about the domain
 * directly (e.g. the lifecycle cron, admin UI).
 */
export function domainCanSend(status: DomainLifecycle): boolean {
  return status === "warming" || status === "active" || status === "tired";
}

// ── Circuit breaker ─────────────────────────────────────────────────────────

export interface BounceBurst {
  /** Hard bounces recorded for this domain in the trailing 24h. */
  hardBounces24h: number;
  /** Size of the most-recent-sends sample used for the rate form. */
  recentSends: number;
  /** Hard bounces within that recent sample. */
  recentHardBounces: number;
}

/**
 * True when a domain's recent hard-bounce activity should immediately tire it
 * (close intake same tick), ahead of the slower health rollup. Either an
 * absolute burst (>= CB_HARD_BOUNCES_24H in 24h) or an elevated rate over a
 * large-enough sample trips it.
 */
export function shouldTripCircuitBreaker(b: BounceBurst): boolean {
  if (b.hardBounces24h >= CB_HARD_BOUNCES_24H) return true;
  if (b.recentSends >= CB_RATE_SAMPLE && b.recentHardBounces / b.recentSends > CB_HARD_BOUNCE_RATE) {
    return true;
  }
  return false;
}

// ── The transition function ─────────────────────────────────────────────────

export interface DomainSignals {
  /** DKIM TXT observed live for this domain: the provisioning → warming gate. */
  dkimVerified: boolean;
  /** Every active mailbox on the domain has graduated its warmup ramp. */
  allMailboxesWarmed: boolean;
  /** Days since DNS went live (registered_at). null = unknown → age gate blocks. */
  domainAgeDays: number | null;
  /**
   * Latest COMPLETE placement test had zero seeds in spam. null = no fresh test
   * (age/warming gate stays closed until one exists). */
  latestPlacementClean: boolean | null;
  /** Majority of placement seeds landed in spam: skip drain, rest immediately. */
  placementMajoritySpam: boolean;
  /** Domain is on the Spamhaus DBL. */
  dblListed: boolean;
  /** Current domain health band (rollup). null = not yet scored. */
  healthBand: HealthBand | null;
  /** Consecutive daily rollups in the `watch` band. */
  watchStreak: number;
  /**
   * Set by the cron when a rest has elapsed but a fresh probe still shows the
   * domain failing (spam/DBL): it burns instead of re-warming.
   */
  restedButStillBad: boolean;
}

export interface LifecycleTimers {
  /** epoch ms; when a `tired` domain finishes draining. */
  drainUntil: number | null;
  /** epoch ms; when a `resting` domain finishes resting. */
  restUntil: number | null;
}

export interface LifecycleDecision {
  next: DomainLifecycle;
  /** Did the state actually change? (convenience for the cron.) */
  changed: boolean;
  /** One-line, human explanation for the transition log. */
  reason: string;
}

/**
 * Decide a domain's next lifecycle state. Pure over its inputs. The cron applies
 * the result (and, on a transition into tired/resting, sets the matching timer
 * via enterTimers()).
 */
export function decideLifecycle(
  status: DomainLifecycle,
  s: DomainSignals,
  now: number,
  timers: LifecycleTimers,
): LifecycleDecision {
  const decide = (next: DomainLifecycle, reason: string): LifecycleDecision => ({
    next,
    changed: next !== status,
    reason,
  });

  switch (status) {
    case "provisioning":
      if (s.dblListed) return decide("burned", "DBL-listed during provisioning.");
      if (s.dkimVerified) return decide("warming", "DKIM verified, begin warmup.");
      return decide("provisioning", "Awaiting DKIM verification.");

    case "warming":
      // A hard failure during warmup skips ahead: DBL → tired (drain then rest),
      // majority-spam → rest immediately (nothing to drain yet worth protecting).
      if (s.dblListed) return decide("tired", "DBL listing during warmup.");
      if (s.placementMajoritySpam) return decide("resting", "Majority-spam placement during warmup.");
      if (
        s.allMailboxesWarmed &&
        s.domainAgeDays != null &&
        s.domainAgeDays >= MIN_DOMAIN_AGE_DAYS &&
        s.latestPlacementClean === true
      ) {
        return decide("active", "Ramp graduated, domain aged, placement clean.");
      }
      return decide("warming", "Still warming.");

    case "active":
      if (s.dblListed) return decide("tired", "DBL listing, close intake and drain.");
      if (s.placementMajoritySpam) return decide("resting", "Majority-spam placement, rest now.");
      if (s.healthBand === "critical") return decide("tired", "Health critical, close intake and drain.");
      if (s.watchStreak >= WATCH_STREAK_FOR_TIRED) {
        return decide("tired", `Health in 'watch' for ${s.watchStreak} consecutive rollups, tire before it burns.`);
      }
      return decide("active", "Healthy.");

    case "tired":
      // Intake is already closed. Drain in-flight follow-ups, but if it degrades
      // further mid-drain, stop and rest immediately.
      if (s.placementMajoritySpam || s.dblListed) {
        return decide("resting", "Degraded further during drain, rest now.");
      }
      if (timers.drainUntil != null && now >= timers.drainUntil) {
        return decide("resting", "Drain window elapsed, begin rest.");
      }
      return decide("tired", "Draining in-flight follow-ups.");

    case "resting":
      if (timers.restUntil != null && now >= timers.restUntil) {
        if (s.restedButStillBad) return decide("burned", "Still failing after a full rest, burned.");
        return decide("warming", "Rest complete, re-warm (with ramp reset).");
      }
      return decide("resting", "Resting.");

    case "burned":
      return decide("burned", "Burned (terminal until manually retired).");

    case "retired":
      return decide("retired", "Retired (terminal).");
  }
}

/**
 * Timers to set when a transition ENTERS a timed state. Returned as ISO strings
 * keyed by the sending_domains column names, so the cron can spread them
 * straight into its update. Empty for states with no timer.
 */
export function enterTimers(next: DomainLifecycle, now: number): {
  drain_until?: string;
  rest_until?: string;
} {
  if (next === "tired") return { drain_until: new Date(now + DRAIN_DAYS * 86_400_000).toISOString() };
  if (next === "resting") return { rest_until: new Date(now + REST_DAYS * 86_400_000).toISOString() };
  return {};
}

/**
 * Daily watch-streak accounting for a domain's health rollup (written by
 * check-inbox-health, read here by decideLifecycle's WATCH_STREAK_FOR_TIRED
 * gate). watch_streak counts CONSECUTIVE UTC DAYS the rollup has sat in the
 * 'watch' band: it advances at most once per UTC day (a same-day re-check, e.g.
 * the hourly health cron, holds it), and resets to 0 the moment the domain
 * leaves 'watch': a 'critical' domain tires via the band directly, not the
 * streak. `priorCheckedAt` is the domain's last health_checked_at (ISO) or null
 * on its first-ever rollup.
 */
export function nextWatchStreak(
  band: HealthBand,
  priorStreak: number,
  priorCheckedAt: string | null,
  nowIso: string,
): number {
  if (band !== "watch") return 0;
  const priorDate = priorCheckedAt ? priorCheckedAt.slice(0, 10) : null;
  const today = nowIso.slice(0, 10);
  return priorDate !== today ? priorStreak + 1 : priorStreak;
}

// ── Signal gathering (pure; consumes already-loaded rows) ───────────────────
// Turns a domain row + its mailboxes + their send counts + their latest
// placement tests into the DomainSignals decideLifecycle() reads. Kept pure (no
// I/O) so the manage-mailbox-lifecycle cron only has to fetch the rows, and so
// the derivation is unit-testable. Reads the domain HEALTH ROLLUP that
// check-inbox-health writes (health_band / health_components / watch_streak).

/** Status of one component in a stored health rollup, or null if absent. */
export function componentStatus(
  components: HealthComponent[] | null | undefined,
  key: HealthComponent["key"],
): HealthComponent["status"] | null {
  if (!components) return null;
  return components.find((c) => c.key === key)?.status ?? null;
}

export function gatherDomainSignals(
  domain: SendingDomain,
  mailboxes: NativeMailbox[],
  totalSentByMailbox: Map<string, number>,
  latestPlacementByMailbox: Map<string, PlacementTest>,
  now: number,
): DomainSignals {
  const components = domain.health_components;
  const dblListed = componentStatus(components, "blacklist") === "bad";
  // DKIM verified when the provisioning stamp is set OR the live DNS check (in
  // the rollup) shows the record present on the domain.
  const dkimVerified =
    domain.dkim_verified_at != null || componentStatus(components, "dkim") === "ok";

  // Ramp graduation: every ACTIVE mailbox on the domain must be past its warmup
  // (counting from its ramp_baseline_sent offset). An empty domain can't graduate.
  const active = mailboxes.filter((m) => m.status === "active");
  const allMailboxesWarmed =
    active.length > 0 &&
    active.every((m) => {
      const adjusted = Math.max(0, (totalSentByMailbox.get(m.id) ?? 0) - (m.ramp_baseline_sent ?? 0));
      return rampStage(adjusted).warmed;
    });

  // Domain age since DNS went live. Fall back to created_at (a lower bound) when
  // registered_at is unset, so a backfilled domain that later re-warms can still
  // graduate.
  const ageBasis = domain.registered_at ?? domain.created_at;
  const domainAgeDays = ageBasis ? Math.floor((now - Date.parse(ageBasis)) / 86_400_000) : null;

  // Placement aggregated across the domain's mailboxes' latest fresh tests.
  const freshTests = mailboxes
    .map((m) => latestPlacementByMailbox.get(m.id))
    .filter((t): t is PlacementTest => !!t);
  const placementMajoritySpam = freshTests.some(
    (t) => t.seeds_total > 0 && t.spam_count / t.seeds_total >= 0.5,
  );
  const latestPlacementClean =
    freshTests.length > 0 ? freshTests.every((t) => t.spam_count === 0) : null;

  const healthBand = (domain.health_band as HealthBand | null) ?? null;
  // After a rest, "still bad" = any hard reputation signal still firing.
  const restedButStillBad = dblListed || placementMajoritySpam || healthBand === "critical";

  return {
    dkimVerified,
    allMailboxesWarmed,
    domainAgeDays,
    latestPlacementClean,
    placementMajoritySpam,
    dblListed,
    healthBand,
    watchStreak: domain.watch_streak ?? 0,
    restedButStillBad,
  };
}
