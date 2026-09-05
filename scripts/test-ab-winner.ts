#!/usr/bin/env node
/**
 * Unit tests for the A/B auto-winner (src/lib/flow/ab-winner.ts): the one-sided
 * two-proportion significance test that pauses losing variants, the probit used
 * for the critical z, and the pure graph merges (mergePausedIntoGraph for the
 * evaluator, mergeStoredPauses for the save route). Pure. Run:
 *   npx tsx scripts/test-ab-winner.ts
 */
import {
  emailNode,
  emailVariant,
  conditionNode,
  walkAll,
  type FlowGraph,
} from "../src/lib/flow/graph.ts";
import type { AbNodeStats, VariantStat } from "../src/lib/flow/variants.ts";
import {
  decideAbWinner,
  resolveAbConfig,
  zCritOneSided,
  mergePausedIntoGraph,
  mergeStoredPauses,
  DEFAULT_AB_WINNER_CONFIG,
  type AbWinnerConfig,
} from "../src/lib/flow/ab-winner.ts";

let pass = 0;
let fail = 0;
function eq<T>(got: T, want: T, msg: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg} (got ${g}, want ${w})`);
  }
}
function ok(cond: boolean, msg: string) {
  eq(cond, true, msg);
}
function near(got: number, want: number, tol: number, msg: string) {
  if (Math.abs(got - want) <= tol) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg} (got ${got}, want ~${want})`);
  }
}

// Build a VariantStat with computed rates (replied defaults to positive count).
function vs(id: string, label: string, sent: number, positive: number, paused = false): VariantStat {
  const denom = sent || 1;
  return {
    id,
    label,
    subject: label,
    sent,
    replied: positive,
    positive,
    replyRatePct: Math.round((positive / denom) * 1000) / 10,
    positiveRatePct: Math.round((positive / denom) * 1000) / 10,
    paused,
  };
}
function node(nodeId: string, variants: VariantStat[]): AbNodeStats {
  return { nodeId, firstEmail: true, variants, leaderId: null, winnerId: null, decided: false, autoPause: true };
}
function pausedOf(graph: FlowGraph, id: string): string[] {
  let out: string[] = [];
  walkAll(graph.nodes, (n) => {
    if (n.kind === "email" && n.id === id) out = n.paused_variant_ids ?? [];
  });
  return out;
}

// Auto-pause ENABLED at the default thresholds. The rule is off unless opted in,
// so every "should decide" test passes this.
const ON: AbWinnerConfig = {
  autoPause: true,
  minSentPerVariant: 30,
  minTotalSent: 60,
  minPositives: 3,
  minAbsoluteLeadPct: 1,
  confidence: 0.95,
};

// ── zCritOneSided (probit) ───────────────────────────────────────────────────
console.log("zCritOneSided, inverse-normal critical values");
near(zCritOneSided(0.95), 1.6449, 0.001, "95% one-sided ≈ 1.6449");
near(zCritOneSided(0.975), 1.96, 0.001, "97.5% one-sided ≈ 1.9600");
near(zCritOneSided(0.99), 2.3263, 0.001, "99% one-sided ≈ 2.3263");
near(zCritOneSided(0.9), 1.2816, 0.001, "90% one-sided ≈ 1.2816");

// ── decideAbWinner: opt-in gate ──────────────────────────────────────────────
console.log("decideAbWinner, OFF by default; only acts when opted in");
{
  const blowout = node("e1", [vs("e1", "A", 50, 20), vs("vb", "B", 50, 0)]);
  const off = decideAbWinner(blowout); // DEFAULT config → autoPause false
  eq(off.pauseIds, [], "disabled (default) → no pause even on a blowout");
  ok(off.reason.includes("disabled"), "reason says auto-pause disabled");
  eq(decideAbWinner(blowout, ON).pauseIds, ["vb"], "same node, opted in → pauses the loser");
}

// ── decideAbWinner: the winner rule ──────────────────────────────────────────
console.log("decideAbWinner, gates on volume");
{
  const d = decideAbWinner(node("e1", [vs("e1", "A", 10, 3), vs("vb", "B", 10, 0)]), ON);
  eq(d.pauseIds, [], "too few sends → no pause");
  eq(d.decided, false, "not decided while gathering");
}

console.log("decideAbWinner, pauses a clearly-losing variant");
{
  // A 6/50 (12%) vs B 0/50 (0%): z ≈ 2.53 > 1.6449, 12pt lead, 6 positives → pause B.
  const d = decideAbWinner(node("e1", [vs("e1", "A", 50, 6), vs("vb", "B", 50, 0)]), ON);
  eq(d.leaderId, "e1", "leader = A");
  eq(d.pauseIds, ["vb"], "significant loser B paused");
  eq(d.decided, true, "2-way with a pause → decided");
}

console.log("decideAbWinner, a close gap is NOT significant");
{
  const d = decideAbWinner(node("e1", [vs("e1", "A", 50, 6), vs("vb", "B", 50, 4)]), ON);
  eq(d.pauseIds, [], "small difference → no pause");
  eq(d.decided, false, "not decided");
}

console.log("decideAbWinner, ties + zero-evidence never pause");
{
  eq(decideAbWinner(node("e1", [vs("e1", "A", 50, 5), vs("vb", "B", 50, 5)]), ON).pauseIds, [], "equal rates → no lead → no pause");
  eq(decideAbWinner(node("e1", [vs("e1", "A", 50, 0), vs("vb", "B", 50, 0)]), ON).pauseIds, [], "0 positives → leader fails the evidence gate → no pause");
}

console.log("decideAbWinner, leader needs its own minimum evidence");
{
  // Best rate but < minSent sends.
  eq(decideAbWinner(node("e1", [vs("e1", "A", 10, 3), vs("vb", "B", 60, 0)]), ON).pauseIds, [], "leader under minSent → no verdict");
  // Volume but < minPositives positives → the evidence gate blocks it.
  const thin = decideAbWinner(node("e1", [vs("e1", "A", 50, 2), vs("vb", "B", 50, 0)]), ON);
  eq(thin.pauseIds, [], "leader with 2 positives (<3) → no verdict");
  ok(thin.reason.includes("positive"), "reason cites the evidence gate");
}

console.log("decideAbWinner, a REAL lead is required (not just significance)");
{
  // Huge n makes a 0.5pt gap wildly significant, but it's below the 1pt floor.
  const variants = [vs("e1", "A", 100000, 5500), vs("vb", "B", 100000, 5000)]; // 5.5% vs 5.0%
  eq(decideAbWinner(node("e1", variants), ON).pauseIds, [], "significant but <1pt lead → no pause");
  const loose: AbWinnerConfig = { ...ON, minAbsoluteLeadPct: 0.4 };
  eq(decideAbWinner(node("e1", variants), loose).pauseIds, ["vb"], "drop the lead floor to 0.4pt → pauses");
}

console.log("decideAbWinner, Bonferroni raises the bar for 3+ variants");
{
  // A 14% vs B 4%: pairwise z ≈ 1.75, clears the 2-way bar (1.6449) but not the
  // 3-way corrected bar (1.96).
  eq(decideAbWinner(node("e1", [vs("e1", "A", 50, 7), vs("vb", "B", 50, 2)]), ON).pauseIds, ["vb"], "2-way (k=1): B is beaten");
  eq(
    decideAbWinner(node("e1", [vs("e1", "A", 50, 7), vs("vb", "B", 50, 2), vs("vc", "C", 50, 6)]), ON).pauseIds,
    [],
    "3-way (k=2, z-crit 1.96): the same gap no longer clears the bar",
  );
}

console.log("decideAbWinner, N-way progressive elimination");
{
  // Round 1: A 9/60 (15%), B 1/60, C 6/60 (10%). k=2 → z-crit 1.96. B loses, C survives.
  const r1 = decideAbWinner(node("e1", [vs("e1", "A", 60, 9), vs("vb", "B", 60, 1), vs("vc", "C", 60, 6)]), ON);
  eq(r1.leaderId, "e1", "leader = A");
  eq(r1.pauseIds, ["vb"], "only B clears the corrected bar");
  eq(r1.decided, false, "two active remain → not decided");

  // Round 2: B paused, C now weak. A 12/80 (15%) vs C 4/80 (5%), k=1 → pause C.
  const r2 = decideAbWinner(
    node("e1", [vs("e1", "A", 80, 12), vs("vb", "B", 60, 1, true), vs("vc", "C", 80, 4)]),
    ON,
  );
  eq(r2.pauseIds, ["vc"], "C now loses");
  eq(r2.decided, true, "lone survivor → decided");
}

console.log("decideAbWinner, a lone survivor is already decided");
{
  const d = decideAbWinner(node("e1", [vs("e1", "A", 80, 12), vs("vb", "B", 60, 1, true)]), ON);
  eq(d.pauseIds, [], "nothing new to pause");
  eq(d.leaderId, "e1", "leader = the survivor");
  eq(d.decided, true, "one active + a prior pause → decided");
}

console.log("decideAbWinner, per-node config lowers the bar");
{
  const variants = [vs("e1", "A", 20, 4), vs("vb", "B", 20, 0)]; // 20 each < default minSent 30
  eq(decideAbWinner(node("e1", variants), ON).pauseIds, [], "default thresholds → not enough sends");
  const cfg: AbWinnerConfig = { autoPause: true, minSentPerVariant: 15, minTotalSent: 30, minPositives: 3, minAbsoluteLeadPct: 1, confidence: 0.95 };
  eq(decideAbWinner(node("e1", variants), cfg).pauseIds, ["vb"], "looser config → B paused");
}

console.log("decideAbWinner, default config shape (auto-pause OFF)");
eq(
  DEFAULT_AB_WINNER_CONFIG,
  { autoPause: false, minSentPerVariant: 30, minTotalSent: 60, minPositives: 3, minAbsoluteLeadPct: 1, confidence: 0.95 },
  "documented defaults",
);

// ── resolveAbConfig: node override → campaign default → false ─────────────────
console.log("resolveAbConfig, autoPause cascade");
{
  const plain = emailNode("s", "b", "e1"); // no ab_config
  eq(resolveAbConfig(plain).autoPause, false, "no config, no campaign default → off");
  eq(resolveAbConfig(plain, true).autoPause, true, "no node config → inherits campaign default (on)");
  eq(resolveAbConfig(plain, false).autoPause, false, "no node config → inherits campaign default (off)");

  const forcedOff = emailNode("s", "b", "e2");
  forcedOff.ab_config = { autoPause: false };
  eq(resolveAbConfig(forcedOff, true).autoPause, false, "node OFF overrides a campaign default of on");

  const forcedOn = emailNode("s", "b", "e3");
  forcedOn.ab_config = { autoPause: true, minSentPerVariant: 5 };
  eq(resolveAbConfig(forcedOn, false).autoPause, true, "node ON overrides a campaign default of off");
  eq(resolveAbConfig(forcedOn).minSentPerVariant, 5, "node threshold override flows through");
  eq(resolveAbConfig(forcedOn).minPositives, 3, "unset thresholds fall back to defaults");
}

// ── mergePausedIntoGraph ─────────────────────────────────────────────────────
console.log("mergePausedIntoGraph, union, dedup, validate, recurse");
function sampleGraph(): FlowGraph {
  const e1 = emailNode("A", "a", "e1");
  e1.variants = [emailVariant("B", "b", "vb"), emailVariant("C", "c", "vc")];
  const e2 = emailNode("D", "d", "e2");
  e2.variants = [emailVariant("E", "e", "ve")];
  const cond = conditionNode("replied", [e2], []); // e2 lives inside the yes branch
  return { version: 1, nodes: [e1, cond] };
}
{
  const g = sampleGraph();
  const { graph, changed } = mergePausedIntoGraph(g, [{ nodeId: "e1", pauseIds: ["vb"] }]);
  ok(changed, "adding a real pause reports changed");
  eq(pausedOf(graph, "e1"), ["vb"], "e1 gains vb");
  eq(pausedOf(graph, "e2"), [], "e2 untouched");

  // Invalid id (not a variant of e1) is ignored.
  const inv = mergePausedIntoGraph(g, [{ nodeId: "e1", pauseIds: ["nope"] }]);
  ok(!inv.changed, "unknown variant id → no change");
  ok(inv.graph === g, "unchanged → same graph reference");

  // Nested node inside a condition is reachable.
  const nested = mergePausedIntoGraph(g, [{ nodeId: "e2", pauseIds: ["ve"] }]);
  ok(nested.changed, "nested email node paused");
  eq(pausedOf(nested.graph, "e2"), ["ve"], "e2 (inside condition) gains ve");

  // Dedup against an existing pause; only genuinely-new ids grow the set.
  const g2 = sampleGraph();
  const seeded = mergePausedIntoGraph(g2, [{ nodeId: "e1", pauseIds: ["vb"] }]).graph;
  ok(!mergePausedIntoGraph(seeded, [{ nodeId: "e1", pauseIds: ["vb"] }]).changed, "re-pausing vb → no change");
  const grown = mergePausedIntoGraph(seeded, [{ nodeId: "e1", pauseIds: ["vb", "vc"] }]);
  ok(grown.changed, "adding vc grows the set");
  eq(pausedOf(grown.graph, "e1"), ["vb", "vc"], "union keeps vb + adds vc");

  // No plans → no-op, same reference.
  ok(mergePausedIntoGraph(g, []).graph === g, "empty plans → same graph reference");
  ok(mergePausedIntoGraph(g, [{ nodeId: "e1", pauseIds: [] }]).graph === g, "empty pauseIds → same graph reference");
}

// ── mergeStoredPauses ────────────────────────────────────────────────────────
console.log("mergeStoredPauses, preserve auto-pauses across a manual edit");
{
  const stored = sampleGraph();
  const withPause = mergePausedIntoGraph(stored, [{ nodeId: "e1", pauseIds: ["vb"] }]).graph;

  // The builder re-saves a graph that LOST the pause (loaded before it was set).
  const incoming = sampleGraph(); // e1 has vb + vc, no paused
  const merged = mergeStoredPauses(incoming, withPause);
  eq(pausedOf(merged, "e1"), ["vb"], "stored pause re-applied onto the incoming save");

  // A pause whose variant was deleted in the edit is dropped.
  const e1NoB = emailNode("A", "a", "e1");
  e1NoB.variants = [emailVariant("C", "c", "vc")]; // vb removed
  const edited: FlowGraph = { version: 1, nodes: [e1NoB] };
  eq(pausedOf(mergeStoredPauses(edited, withPause), "e1"), [], "deleted variant → its pause drops");

  // No stored graph / no stored pauses → incoming passes through untouched.
  ok(mergeStoredPauses(incoming, null) === incoming, "stored null → same reference");
  ok(mergeStoredPauses(incoming, sampleGraph()) === incoming, "stored with no pauses → same reference");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
