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
  return { nodeId, firstEmail: true, variants, leaderId: null, winnerId: null, decided: false };
}
function pausedOf(graph: FlowGraph, id: string): string[] {
  let out: string[] = [];
  walkAll(graph.nodes, (n) => {
    if (n.kind === "email" && n.id === id) out = n.paused_variant_ids ?? [];
  });
  return out;
}

// ── zCritOneSided (probit) ───────────────────────────────────────────────────
console.log("zCritOneSided — inverse-normal critical values");
near(zCritOneSided(0.95), 1.6449, 0.001, "95% one-sided ≈ 1.6449");
near(zCritOneSided(0.975), 1.96, 0.001, "97.5% one-sided ≈ 1.9600");
near(zCritOneSided(0.99), 2.3263, 0.001, "99% one-sided ≈ 2.3263");
near(zCritOneSided(0.9), 1.2816, 0.001, "90% one-sided ≈ 1.2816");

// ── decideAbWinner ───────────────────────────────────────────────────────────
console.log("decideAbWinner — gates on volume");
{
  // Below minTotalSent → no verdict.
  const d = decideAbWinner(node("e1", [vs("e1", "A", 10, 3), vs("vb", "B", 10, 0)]));
  eq(d.pauseIds, [], "too few sends → no pause");
  eq(d.decided, false, "not decided while gathering");
}

console.log("decideAbWinner — pauses a clearly-losing variant");
{
  // A 6/50 (12%) vs B 0/50 (0%): one-sided z ≈ 2.53 > 1.6449 → pause B.
  const d = decideAbWinner(node("e1", [vs("e1", "A", 50, 6), vs("vb", "B", 50, 0)]));
  eq(d.leaderId, "e1", "leader = A");
  eq(d.pauseIds, ["vb"], "significant loser B paused");
  eq(d.decided, true, "2-way with a pause → decided");
}

console.log("decideAbWinner — a close gap is NOT significant");
{
  // A 6/50 (12%) vs B 4/50 (8%): z ≈ 0.67 → keep both.
  const d = decideAbWinner(node("e1", [vs("e1", "A", 50, 6), vs("vb", "B", 50, 4)]));
  eq(d.pauseIds, [], "small difference → no pause");
  eq(d.decided, false, "not decided");
}

console.log("decideAbWinner — ties + zero-evidence never pause");
{
  eq(decideAbWinner(node("e1", [vs("e1", "A", 50, 5), vs("vb", "B", 50, 5)])).pauseIds, [], "equal rates → no pause");
  eq(decideAbWinner(node("e1", [vs("e1", "A", 50, 0), vs("vb", "B", 50, 0)])).pauseIds, [], "0 vs 0 positives → no pause (degenerate SE)");
}

console.log("decideAbWinner — leader needs its own minimum evidence");
{
  // Big challenger sample but the leader itself has < minSent sends.
  const d = decideAbWinner(node("e1", [vs("e1", "A", 10, 3), vs("vb", "B", 60, 0)]));
  eq(d.pauseIds, [], "leader under minSent → no verdict");
}

console.log("decideAbWinner — N-way progressive elimination");
{
  // Round 1: A 9/60 (15%), B 1/60 (1.7%), C 6/60 (10%). B loses to A, C survives.
  const r1 = decideAbWinner(node("e1", [vs("e1", "A", 60, 9), vs("vb", "B", 60, 1), vs("vc", "C", 60, 6)]));
  eq(r1.leaderId, "e1", "leader = A");
  eq(r1.pauseIds, ["vb"], "only B is significantly worse");
  eq(r1.decided, false, "two active remain → not decided");

  // Round 2: B already paused, C now weak. A 12/80 (15%) vs C 4/80 (5%) → pause C.
  const r2 = decideAbWinner(
    node("e1", [vs("e1", "A", 80, 12), vs("vb", "B", 60, 1, true), vs("vc", "C", 80, 4)]),
  );
  eq(r2.pauseIds, ["vc"], "C now loses");
  eq(r2.decided, true, "lone survivor → decided");
}

console.log("decideAbWinner — a lone survivor is already decided");
{
  const d = decideAbWinner(node("e1", [vs("e1", "A", 80, 12), vs("vb", "B", 60, 1, true)]));
  eq(d.pauseIds, [], "nothing new to pause");
  eq(d.leaderId, "e1", "leader = the survivor");
  eq(d.decided, true, "one active + a prior pause → decided");
}

console.log("decideAbWinner — per-node config lowers the bar");
{
  const variants = [vs("e1", "A", 20, 4), vs("vb", "B", 20, 0)]; // 20 each < default minSent 30
  eq(decideAbWinner(node("e1", variants)).pauseIds, [], "default config → not enough sends");
  const cfg: AbWinnerConfig = { minSentPerVariant: 15, minTotalSent: 30, confidence: 0.95 };
  eq(decideAbWinner(node("e1", variants), cfg).pauseIds, ["vb"], "looser config → B paused");
}

console.log("decideAbWinner — default config shape");
eq(DEFAULT_AB_WINNER_CONFIG, { minSentPerVariant: 30, minTotalSent: 60, confidence: 0.95 }, "documented defaults");

// ── mergePausedIntoGraph ─────────────────────────────────────────────────────
console.log("mergePausedIntoGraph — union, dedup, validate, recurse");
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
console.log("mergeStoredPauses — preserve auto-pauses across a manual edit");
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
