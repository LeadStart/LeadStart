#!/usr/bin/env node
/**
 * Unit tests for the flow-graph runtime walker (src/lib/flow/runtime.ts).
 * Pure function: no network, no DB, no clock. Run:
 *   npx tsx scripts/test-flow-runtime.ts
 *
 * Covers: fresh start, wait accumulation, top-level + nested conditions (both
 * branches), untracked-trigger fail-safe, linkedin/internal side-effects, the
 * rejoin-after-condition path (matches graphToSteps), the legacy-linear graph,
 * pre-migration NULL→node resolution, and the complete/edge cases.
 */
import {
  resolveFlowAction,
  evalCondition,
  isUntrackedTrigger,
  primaryEmails,
  type FlowSignals,
  type FlowRuntimeAction,
} from "../src/lib/flow/runtime.ts";
import {
  emailNode,
  waitNode,
  linkedinNode,
  internalNode,
  conditionNode,
  stepsToGraph,
  graphToSteps,
  type FlowGraph,
  type FlowNode,
} from "../src/lib/flow/graph.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${g}, want ${w})`);
  }
}

const NEITHER: FlowSignals = { hasReplied: false, hasBounced: false };
const REPLIED: FlowSignals = { hasReplied: true, hasBounced: false };
const BOUNCED: FlowSignals = { hasReplied: false, hasBounced: true };

const g = (nodes: FlowNode[]): FlowGraph => ({ version: 1, nodes });

/** Compact, comparable view of an action. */
function info(a: FlowRuntimeAction) {
  if (a.type === "complete") return { type: "complete" };
  return {
    type: a.type,
    id: a.node.id,
    waitDays: a.waitDays,
    triggers: [...a.passedTriggers].sort(),
  };
}

// ── evalCondition + untracked triggers ───────────────────────────────────────
console.log("evalCondition — condition semantics");
eq(evalCondition("replied", REPLIED), true, "replied + hasReplied → yes");
eq(evalCondition("replied", NEITHER), false, "replied + not → no");
eq(evalCondition("bounced", BOUNCED), true, "bounced + hasBounced → yes");
eq(evalCondition("bounced", NEITHER), false, "bounced + not → no");
eq(evalCondition("opened", REPLIED), false, "opened → no (untracked, even if replied)");
eq(evalCondition("clicked", BOUNCED), false, "clicked → no (untracked)");
eq(evalCondition("manual", REPLIED), false, "manual → no (untracked)");
eq(isUntrackedTrigger("opened"), true, "opened is untracked");
eq(isUntrackedTrigger("clicked"), true, "clicked is untracked");
eq(isUntrackedTrigger("manual"), true, "manual is untracked");
eq(isUntrackedTrigger("replied"), false, "replied is tracked");
eq(isUntrackedTrigger("bounced"), false, "bounced is tracked");

// ── Fresh start + wait accumulation ──────────────────────────────────────────
console.log("fresh start + wait accumulation");
{
  const graph = g([emailNode("Hi", "b", "e1")]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: null, emailsSent: 0 }, NEITHER)),
    { type: "email", id: "e1", waitDays: 0, triggers: [] },
    "fresh enrollment → first email, wait 0",
  );
}
{
  // wait BEFORE the first email → the first send is delayed.
  const graph = g([waitNode(2, "w0"), emailNode("Hi", "b", "e1")]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: null, emailsSent: 0 }, NEITHER)),
    { type: "email", id: "e1", waitDays: 2, triggers: [] },
    "leading wait → first email waits 2",
  );
}
{
  // email1 → wait2 → wait3 → email2 : consecutive waits ADD (like graphToSteps).
  const graph = g([
    emailNode("Hi", "b", "e1"),
    waitNode(2, "w1"),
    waitNode(3, "w2"),
    emailNode("", "b2", "e2"),
  ]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, NEITHER)),
    { type: "email", id: "e2", waitDays: 5, triggers: [] },
    "after e1 → e2 with accumulated wait 2+3=5",
  );
}

// ── Top-level condition, both branches (lazy re-eval: same position, diff signal)
console.log("top-level condition — both branches");
{
  const graph = g([
    emailNode("Hi", "b", "e1"),
    conditionNode(
      "replied",
      [internalNode("notify", "Ping AM", "int1")],
      [waitNode(3, "w1"), emailNode("", "b2", "e2")],
      "c1",
    ),
  ]);
  const pos = { currentNodeId: "e1", emailsSent: 1 };
  eq(
    info(resolveFlowAction(graph, pos, NEITHER)),
    { type: "email", id: "e2", waitDays: 3, triggers: ["replied"] },
    "not replied → NO branch → e2 (wait 3), passed replied",
  );
  eq(
    info(resolveFlowAction(graph, pos, REPLIED)),
    { type: "internal", id: "int1", waitDays: 0, triggers: ["replied"] },
    "replied → YES branch → internal notify (same position, lazy re-eval)",
  );
}

// ── Nested condition, both branches of the inner one ─────────────────────────
console.log("nested condition");
{
  // cond1(replied) NO: [ cond2(bounced) YES:[internal], NO:[email] ]
  const graph = g([
    emailNode("Hi", "b", "e1"),
    conditionNode(
      "replied",
      [emailNode("", "peel", "eYes")],
      [
        conditionNode(
          "bounced",
          [internalNode("notify", "bounced!", "int2")],
          [emailNode("", "cont", "e2")],
          "c2",
        ),
      ],
      "c1",
    ),
  ]);
  const pos = { currentNodeId: "e1", emailsSent: 1 };
  eq(
    info(resolveFlowAction(graph, pos, NEITHER)),
    { type: "email", id: "e2", waitDays: 0, triggers: ["bounced", "replied"] },
    "not replied, not bounced → inner NO → e2 (passed both triggers)",
  );
  eq(
    info(resolveFlowAction(graph, pos, BOUNCED)),
    { type: "internal", id: "int2", waitDays: 0, triggers: ["bounced", "replied"] },
    "not replied, bounced → inner YES → internal",
  );
  eq(
    info(resolveFlowAction(graph, pos, REPLIED)),
    { type: "email", id: "eYes", waitDays: 0, triggers: ["replied"] },
    "replied → outer YES → eYes (inner not traversed)",
  );
}

// ── Untracked trigger always takes NO ────────────────────────────────────────
console.log("untracked trigger routing");
{
  const graph = g([
    emailNode("Hi", "b", "e1"),
    conditionNode("opened", [emailNode("", "y", "eY")], [emailNode("", "n", "eN")], "c1"),
  ]);
  const pos = { currentNodeId: "e1", emailsSent: 1 };
  eq(
    info(resolveFlowAction(graph, pos, NEITHER)),
    { type: "email", id: "eN", waitDays: 0, triggers: ["opened"] },
    "opened → NO branch (no signal)",
  );
  eq(
    info(resolveFlowAction(graph, pos, REPLIED)),
    { type: "email", id: "eN", waitDays: 0, triggers: ["opened"] },
    "opened → NO branch even when replied (untracked ignores other signals)",
  );
}

// ── LinkedIn side-effect node is actionable ──────────────────────────────────
console.log("linkedin + internal side-effect nodes");
{
  const graph = g([
    emailNode("Hi", "b", "e1"),
    waitNode(1, "w1"),
    linkedinNode("connect_request", "connect", "li1"),
    emailNode("", "after", "e2"),
  ]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, NEITHER)),
    { type: "linkedin", id: "li1", waitDays: 1, triggers: [] },
    "after e1 → linkedin task (wait 1)",
  );
  // After the linkedin node fires, the wait carries to the next email.
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "li1", emailsSent: 1 }, NEITHER)),
    { type: "email", id: "e2", waitDays: 0, triggers: [] },
    "after linkedin → e2 (wait 0, waits before li already spent)",
  );
}

// ── Rejoin after a condition (sibling after the condition) ───────────────────
console.log("rejoin after condition (matches graphToSteps primary path)");
{
  // [ e1, cond(replied) YES:[eYes] NO:[eNo], e3 ]  — a sibling after the cond.
  const graph = g([
    emailNode("A", "b", "e1"),
    conditionNode("replied", [emailNode("", "y", "eYes")], [emailNode("", "n", "eNo")], "c1"),
    emailNode("", "b3", "e3"),
  ]);
  // Not replied: e1 → eNo → e3 (NO branch then rejoin to the sibling e3).
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, NEITHER)),
    { type: "email", id: "eNo", waitDays: 0, triggers: ["replied"] },
    "after e1, not replied → eNo",
  );
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "eNo", emailsSent: 2 }, NEITHER)),
    { type: "email", id: "e3", waitDays: 0, triggers: [] },
    "after eNo → rejoins parent spine to e3",
  );
  // The primary (NO) path emails must equal graphToSteps' order.
  eq(
    primaryEmails(graph).map((n) => n.id),
    ["e1", "eNo", "e3"],
    "primaryEmails follows NO branch then rejoins: e1, eNo, e3",
  );
  eq(graphToSteps(graph).length, 3, "graphToSteps agrees: 3 emails on the primary path");
}

// ── Legacy-linear graph walks identically to graphToSteps ────────────────────
console.log("legacy-linear graph (stepsToGraph) — walker reproduces the linear sequence");
{
  // A linear campaign rendered as a graph: 3 emails, waits 0/3/2.
  const graph = stepsToGraph([
    { wait_days: 0, subject_template: "S0", body_template: "b0" },
    { wait_days: 3, subject_template: null, body_template: "b1" },
    { wait_days: 2, subject_template: null, body_template: "b2" },
  ]);
  const emails = primaryEmails(graph);
  eq(emails.length, 3, "3 email nodes");
  // Walk it node-by-node the way the cron would, threading position + emailsSent.
  const seq: { id: string; waitDays: number }[] = [];
  let pos = { currentNodeId: null as string | null, emailsSent: 0 };
  for (let guard = 0; guard < 10; guard++) {
    const a = resolveFlowAction(graph, pos, NEITHER);
    if (a.type === "complete") break;
    if (a.type !== "email") throw new Error("linear graph produced a non-email action");
    seq.push({ id: a.node.id, waitDays: a.waitDays });
    pos = { currentNodeId: a.node.id, emailsSent: pos.emailsSent + 1 };
  }
  eq(
    seq.map((s) => s.waitDays),
    [0, 3, 2],
    "walker yields the same wait cadence as the linear steps (0,3,2)",
  );
  eq(
    seq.map((s) => s.id),
    emails.map((e) => e.id),
    "walker visits the 3 emails in order",
  );
  eq(
    graphToSteps(graph).map((s) => s.wait_days),
    [0, 3, 2],
    "graphToSteps agrees on the cadence",
  );
}

// ── Pre-migration NULL→node resolution (no re-send) ──────────────────────────
console.log("pre-migration in-flight resolution (currentNodeId NULL, emailsSent>0)");
{
  const graph = g([
    emailNode("S0", "b0", "e1"),
    waitNode(3, "w1"),
    emailNode("", "b1", "e2"),
    waitNode(2, "w2"),
    emailNode("", "b2", "e3"),
  ]);
  // Sent 2 emails already, current_node_id NULL (row predates migration 00089).
  eq(
    info(resolveFlowAction(graph, { currentNodeId: null, emailsSent: 2 }, NEITHER)),
    { type: "email", id: "e3", waitDays: 2, triggers: [] },
    "emailsSent=2 → resumes at e3 (after e2), NOT re-sending e1/e2",
  );
  // Sent 1 → resumes at e2.
  eq(
    info(resolveFlowAction(graph, { currentNodeId: null, emailsSent: 1 }, NEITHER)),
    { type: "email", id: "e2", waitDays: 3, triggers: [] },
    "emailsSent=1 → resumes at e2",
  );
  // Sent more than the graph now has → complete (graph shrank under the row).
  eq(
    info(resolveFlowAction(graph, { currentNodeId: null, emailsSent: 9 }, NEITHER)),
    { type: "complete" },
    "emailsSent beyond the graph → complete",
  );
}

// ── Complete / edge cases ────────────────────────────────────────────────────
console.log("complete + edge cases");
{
  const graph = g([emailNode("Hi", "b", "e1")]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, NEITHER)),
    { type: "complete" },
    "after the last node → complete",
  );
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "ghost", emailsSent: 1 }, NEITHER)),
    { type: "complete" },
    "parked node deleted from graph → complete (no restart/resend)",
  );
  eq(
    info(resolveFlowAction(g([]), { currentNodeId: null, emailsSent: 0 }, NEITHER)),
    { type: "complete" },
    "empty graph → complete",
  );
}
{
  // Condition whose chosen branch is empty → complete (peel-off with no action).
  const graph = g([
    emailNode("Hi", "b", "e1"),
    conditionNode("replied", [], [emailNode("", "n", "e2")], "c1"),
  ]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, REPLIED)),
    { type: "complete" },
    "replied → empty YES branch → complete",
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
