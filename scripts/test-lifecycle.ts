#!/usr/bin/env node
/**
 * Unit tests for the sending-domain lifecycle module (burn-prevention state
 * machine). No network, no DB. Run: npx tsx scripts/test-lifecycle.ts
 */
import {
  decideLifecycle,
  domainOpenForNewLeads,
  domainCanSend,
  shouldTripCircuitBreaker,
  enterTimers,
  nextWatchStreak,
  gatherDomainSignals,
  DRAIN_DAYS,
  REST_DAYS,
  MIN_DOMAIN_AGE_DAYS,
  WATCH_STREAK_FOR_TIRED,
  type DomainSignals,
  type LifecycleTimers,
} from "../src/lib/deliverability/lifecycle.ts";
import type {
  DomainLifecycle,
  HealthComponent,
  NativeMailbox,
  PlacementTest,
  SendingDomain,
} from "../src/types/app.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

const NOW = 1_700_000_000_000; // fixed clock (Date.now() is banned in these scripts anyway)
const NOW_ISO = new Date(NOW).toISOString();
const DAY = 86_400_000;

// A clean, fully-warmed, healthy domain. Override per case.
const clean: DomainSignals = {
  dkimVerified: true,
  allMailboxesWarmed: true,
  domainAgeDays: 30,
  latestPlacementClean: true,
  placementMajoritySpam: false,
  dblListed: false,
  healthBand: "healthy",
  watchStreak: 0,
  restedButStillBad: false,
};
const sig = (over: Partial<DomainSignals>): DomainSignals => ({ ...clean, ...over });
const noTimers: LifecycleTimers = { drainUntil: null, restUntil: null };
const decide = (status: DomainLifecycle, over: Partial<DomainSignals>, timers: LifecycleTimers = noTimers) =>
  decideLifecycle(status, sig(over), NOW, timers);

// ── Send-eligibility helpers ────────────────────────────────────────────────
console.log("domainOpenForNewLeads — only warming + active accept new step-0 leads");
eq(domainOpenForNewLeads("warming"), true, "warming open to new leads");
eq(domainOpenForNewLeads("active"), true, "active open to new leads");
eq(domainOpenForNewLeads("tired"), false, "tired CLOSED to new leads (drain)");
eq(domainOpenForNewLeads("resting"), false, "resting closed to new leads");
eq(domainOpenForNewLeads("provisioning"), false, "provisioning closed to new leads");
eq(domainOpenForNewLeads("burned"), false, "burned closed");
eq(domainOpenForNewLeads("retired"), false, "retired closed");

console.log("domainCanSend — tired can still send (follow-ups); resting cannot");
eq(domainCanSend("warming"), true, "warming can send");
eq(domainCanSend("active"), true, "active can send");
eq(domainCanSend("tired"), true, "tired can send in-flight follow-ups");
eq(domainCanSend("resting"), false, "resting sends nothing");
eq(domainCanSend("provisioning"), false, "provisioning cannot send");
eq(domainCanSend("burned"), false, "burned cannot send");

// ── Circuit breaker ─────────────────────────────────────────────────────────
console.log("shouldTripCircuitBreaker");
eq(shouldTripCircuitBreaker({ hardBounces24h: 3, recentSends: 0, recentHardBounces: 0 }), true, "3 hard bounces in 24h trips (absolute)");
eq(shouldTripCircuitBreaker({ hardBounces24h: 2, recentSends: 0, recentHardBounces: 0 }), false, "2 hard bounces in 24h does not trip");
eq(shouldTripCircuitBreaker({ hardBounces24h: 2, recentSends: 20, recentHardBounces: 2 }), true, "2/20 = 10% over full sample trips (rate)");
eq(shouldTripCircuitBreaker({ hardBounces24h: 0, recentSends: 20, recentHardBounces: 1 }), false, "1/20 = 5% is not > 5% (boundary)");
eq(shouldTripCircuitBreaker({ hardBounces24h: 0, recentSends: 10, recentHardBounces: 5 }), false, "50% but sample < 20 does not trip");
eq(shouldTripCircuitBreaker({ hardBounces24h: 0, recentSends: 100, recentHardBounces: 6 }), true, "6/100 = 6% over large sample trips");

// ── provisioning ────────────────────────────────────────────────────────────
console.log("decideLifecycle — provisioning");
eq(decide("provisioning", { dkimVerified: false }).next, "provisioning", "no DKIM yet → stay provisioning");
eq(decide("provisioning", { dkimVerified: false }).changed, false, "no-change flag false when staying");
eq(decide("provisioning", { dkimVerified: true }).next, "warming", "DKIM verified → warming");
eq(decide("provisioning", { dkimVerified: true }).changed, true, "change flag true on provisioning→warming");
eq(decide("provisioning", { dblListed: true }).next, "burned", "DBL during provisioning → burned");

// ── warming ─────────────────────────────────────────────────────────────────
console.log("decideLifecycle — warming");
eq(decide("warming", {}).next, "active", "warmed + aged + clean placement → active");
eq(decide("warming", { allMailboxesWarmed: false }).next, "warming", "not all mailboxes warmed → stay warming");
eq(decide("warming", { domainAgeDays: MIN_DOMAIN_AGE_DAYS - 1 }).next, "warming", "too young → stay warming even if ramp done");
eq(decide("warming", { domainAgeDays: null }).next, "warming", "unknown age → stay warming (gate closed)");
eq(decide("warming", { latestPlacementClean: null }).next, "warming", "no fresh placement test → stay warming");
eq(decide("warming", { latestPlacementClean: false }).next, "warming", "placement not clean → stay warming");
eq(decide("warming", { dblListed: true }).next, "tired", "DBL during warmup → tired");
eq(decide("warming", { placementMajoritySpam: true }).next, "resting", "majority-spam during warmup → resting");

// ── active ──────────────────────────────────────────────────────────────────
console.log("decideLifecycle — active");
eq(decide("active", {}).next, "active", "healthy → stay active");
eq(decide("active", {}).changed, false, "healthy active is not a change");
eq(decide("active", { dblListed: true }).next, "tired", "DBL → tired");
eq(decide("active", { placementMajoritySpam: true }).next, "resting", "majority-spam → resting immediately");
eq(decide("active", { healthBand: "critical" }).next, "tired", "health critical → tired");
eq(decide("active", { watchStreak: WATCH_STREAK_FOR_TIRED }).next, "tired", "watch streak at threshold → tired");
eq(decide("active", { watchStreak: WATCH_STREAK_FOR_TIRED - 1 }).next, "active", "watch streak below threshold → stay active");
eq(decide("active", { healthBand: "watch", watchStreak: 1 }).next, "active", "single watch day → stay active (noise)");

// ── tired (drain) ───────────────────────────────────────────────────────────
console.log("decideLifecycle — tired");
eq(decide("tired", {}, { drainUntil: NOW + DAY, restUntil: null }).next, "tired", "drain window open → keep draining");
eq(decide("tired", {}, { drainUntil: NOW - DAY, restUntil: null }).next, "resting", "drain elapsed → resting");
eq(decide("tired", {}, { drainUntil: null, restUntil: null }).next, "tired", "no drain timer set → stay tired (cron sets it on entry)");
eq(decide("tired", { dblListed: true }, { drainUntil: NOW + DAY, restUntil: null }).next, "resting", "DBL mid-drain → rest now");
eq(decide("tired", { placementMajoritySpam: true }, { drainUntil: NOW + DAY, restUntil: null }).next, "resting", "majority-spam mid-drain → rest now");

// ── resting ─────────────────────────────────────────────────────────────────
console.log("decideLifecycle — resting");
eq(decide("resting", {}, { drainUntil: null, restUntil: NOW + DAY }).next, "resting", "rest not elapsed → keep resting");
eq(decide("resting", {}, { drainUntil: null, restUntil: NOW - DAY }).next, "warming", "rest elapsed, recovered → re-warm");
eq(decide("resting", {}, { drainUntil: null, restUntil: NOW - DAY }).changed, true, "resting→warming is a change");
eq(decide("resting", { restedButStillBad: true }, { drainUntil: null, restUntil: NOW - DAY }).next, "burned", "rest elapsed but still bad → burned");
eq(decide("resting", {}, { drainUntil: null, restUntil: null }).next, "resting", "no rest timer → stay resting");

// ── terminal states ─────────────────────────────────────────────────────────
console.log("decideLifecycle — terminal states are stable");
eq(decide("burned", { dkimVerified: true }).next, "burned", "burned never leaves on its own");
eq(decide("retired", {}).next, "retired", "retired is terminal");

// ── enterTimers ─────────────────────────────────────────────────────────────
console.log("enterTimers — sets the right timer on entry");
eq(enterTimers("tired", NOW).drain_until, new Date(NOW + DRAIN_DAYS * DAY).toISOString(), "tired sets drain_until = now + DRAIN_DAYS");
eq(enterTimers("tired", NOW).rest_until, undefined, "tired sets no rest_until");
eq(enterTimers("resting", NOW).rest_until, new Date(NOW + REST_DAYS * DAY).toISOString(), "resting sets rest_until = now + REST_DAYS");
eq(enterTimers("resting", NOW).drain_until, undefined, "resting sets no drain_until");
eq(Object.keys(enterTimers("active", NOW)).length, 0, "active sets no timers");
eq(Object.keys(enterTimers("warming", NOW)).length, 0, "warming sets no timers");

// ── nextWatchStreak (daily accounting) ──────────────────────────────────────
console.log("nextWatchStreak — counts consecutive UTC days in 'watch'");
eq(nextWatchStreak("healthy", 5, "2026-08-25T12:00:00.000Z", "2026-08-26T10:00:00.000Z"), 0, "leaving watch resets to 0");
eq(nextWatchStreak("critical", 5, "2026-08-25T12:00:00.000Z", "2026-08-26T10:00:00.000Z"), 0, "critical resets streak (tires via band, not streak)");
eq(nextWatchStreak("watch", 0, null, "2026-08-26T10:00:00.000Z"), 1, "first-ever watch rollup → 1");
eq(nextWatchStreak("watch", 2, "2026-08-25T23:00:00.000Z", "2026-08-26T01:00:00.000Z"), 3, "new UTC day in watch advances 2 → 3");
eq(nextWatchStreak("watch", 2, "2026-08-26T00:30:00.000Z", "2026-08-26T09:30:00.000Z"), 2, "same UTC day re-check holds at 2 (hourly cron doesn't inflate)");
eq(nextWatchStreak("watch", WATCH_STREAK_FOR_TIRED - 1, "2026-08-25T12:00:00.000Z", "2026-08-26T12:00:00.000Z"), WATCH_STREAK_FOR_TIRED, "reaches the tire threshold on the 3rd distinct day");

// ── gatherDomainSignals (pure signal derivation) ────────────────────────────
console.log("gatherDomainSignals — derives DomainSignals from rows");

const comp = (key: HealthComponent["key"], status: HealthComponent["status"]): HealthComponent =>
  ({ key, label: key, status, deduction: 0, detail: "" });
const dom = (o: Partial<SendingDomain>): SendingDomain =>
  ({
    health_components: null,
    dkim_verified_at: null,
    registered_at: null,
    created_at: new Date(NOW - 400 * DAY).toISOString(), // old by default
    health_band: null,
    watch_streak: 0,
    ...o,
  } as unknown as SendingDomain);
const mbx = (id: string, status: string, over: Partial<NativeMailbox> = {}): NativeMailbox =>
  ({ id, status, ramp_baseline_sent: 0, ...over } as unknown as NativeMailbox);
const ptest = (seeds_total: number, spam_count: number): PlacementTest =>
  ({ seeds_total, spam_count } as unknown as PlacementTest);
const sent = (pairs: Array<[string, number]>) => new Map<string, number>(pairs);
const place = (pairs: Array<[string, PlacementTest]>) => new Map<string, PlacementTest>(pairs);

// dblListed
eq(gatherDomainSignals(dom({ health_components: [comp("blacklist", "bad")] }), [], sent([]), place([]), NOW).dblListed, true, "blacklist 'bad' component → dblListed");
eq(gatherDomainSignals(dom({ health_components: [comp("blacklist", "ok")] }), [], sent([]), place([]), NOW).dblListed, false, "blacklist 'ok' → not listed");
eq(gatherDomainSignals(dom({ health_components: null }), [], sent([]), place([]), NOW).dblListed, false, "null components → not listed");

// dkimVerified
eq(gatherDomainSignals(dom({ dkim_verified_at: NOW_ISO }), [], sent([]), place([]), NOW).dkimVerified, true, "dkim_verified_at set → verified");
eq(gatherDomainSignals(dom({ health_components: [comp("dkim", "ok")] }), [], sent([]), place([]), NOW).dkimVerified, true, "dkim component 'ok' → verified");
eq(gatherDomainSignals(dom({}), [], sent([]), place([]), NOW).dkimVerified, false, "no stamp, no component → not verified");

// allMailboxesWarmed (rampStage.warmed is true at cumulative >= 180)
eq(gatherDomainSignals(dom({}), [mbx("m1", "active")], sent([["m1", 200]]), place([]), NOW).allMailboxesWarmed, true, "one active mailbox past ramp → warmed");
eq(gatherDomainSignals(dom({}), [mbx("m1", "active")], sent([["m1", 50]]), place([]), NOW).allMailboxesWarmed, false, "active mailbox mid-ramp → not warmed");
eq(gatherDomainSignals(dom({}), [mbx("m1", "active"), mbx("m2", "active")], sent([["m1", 200], ["m2", 50]]), place([]), NOW).allMailboxesWarmed, false, "one warmed + one not → not all warmed");
eq(gatherDomainSignals(dom({}), [mbx("m1", "active", { ramp_baseline_sent: 200 })], sent([["m1", 200]]), place([]), NOW).allMailboxesWarmed, false, "baseline offset resets ramp → not warmed (adjusted 0)");
eq(gatherDomainSignals(dom({}), [mbx("m1", "paused")], sent([["m1", 500]]), place([]), NOW).allMailboxesWarmed, false, "no ACTIVE mailboxes → not warmed");
eq(gatherDomainSignals(dom({}), [], sent([]), place([]), NOW).allMailboxesWarmed, false, "empty domain → not warmed");

// domainAgeDays
eq(gatherDomainSignals(dom({ registered_at: new Date(NOW - 30 * DAY).toISOString() }), [], sent([]), place([]), NOW).domainAgeDays, 30, "registered 30d ago → age 30");
eq(gatherDomainSignals(dom({ registered_at: null, created_at: new Date(NOW - 5 * DAY).toISOString() }), [], sent([]), place([]), NOW).domainAgeDays, 5, "null registered_at falls back to created_at");

// placement aggregation
eq(gatherDomainSignals(dom({}), [mbx("m1", "active")], sent([]), place([["m1", ptest(4, 3)]]), NOW).placementMajoritySpam, true, "3/4 seeds spam → majority spam");
eq(gatherDomainSignals(dom({}), [mbx("m1", "active")], sent([]), place([["m1", ptest(4, 1)]]), NOW).placementMajoritySpam, false, "1/4 seeds spam → not majority");
eq(gatherDomainSignals(dom({}), [mbx("m1", "active")], sent([]), place([["m1", ptest(4, 0)]]), NOW).latestPlacementClean, true, "0 spam across a fresh test → clean");
eq(gatherDomainSignals(dom({}), [mbx("m1", "active"), mbx("m2", "active")], sent([]), place([["m1", ptest(4, 0)], ["m2", ptest(4, 1)]]), NOW).latestPlacementClean, false, "one mailbox with spam → domain not clean");
eq(gatherDomainSignals(dom({}), [mbx("m1", "active")], sent([]), place([]), NOW).latestPlacementClean, null, "no fresh test → clean is null (unknown)");

// restedButStillBad + passthroughs
eq(gatherDomainSignals(dom({ health_band: "critical" }), [], sent([]), place([]), NOW).restedButStillBad, true, "critical band → still bad");
eq(gatherDomainSignals(dom({ health_components: [comp("blacklist", "bad")] }), [], sent([]), place([]), NOW).restedButStillBad, true, "DBL → still bad");
eq(gatherDomainSignals(dom({ health_band: "healthy" }), [], sent([]), place([]), NOW).restedButStillBad, false, "healthy, clean → not still bad");
eq(gatherDomainSignals(dom({ watch_streak: 4 }), [], sent([]), place([]), NOW).watchStreak, 4, "watch_streak passthrough");
eq(gatherDomainSignals(dom({ health_band: "watch" }), [], sent([]), place([]), NOW).healthBand, "watch", "healthBand passthrough");

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
