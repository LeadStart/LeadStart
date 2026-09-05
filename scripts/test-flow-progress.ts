#!/usr/bin/env node
/**
 * Unit tests for the flow-progress calculator (src/lib/flow/progress.ts).
 * Pure: no DB. Run: npx tsx scripts/test-flow-progress.ts
 */
import {
  computeFlowProgress,
  collectNodeIds,
  subtreeActive,
  type ProgressEnrollment,
} from "../src/lib/flow/progress.ts";
import {
  emailNode,
  conditionNode,
  internalNode,
  waitNode,
  type FlowGraph,
} from "../src/lib/flow/graph.ts";
import type { ReplyClass } from "../src/types/app.ts";

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

// Graph: e1 → replied? yes:[notify] no:[wait, e2]
const GRAPH: FlowGraph = {
  version: 1,
  nodes: [
    emailNode("Hi", "b", "e1"),
    conditionNode(
      "replied",
      [internalNode("notify", "peel", "notify")],
      [waitNode(2, "w1"), emailNode("", "b2", "e2")],
      "c1",
    ),
  ],
};

const enr = (
  status: string,
  node: string | null,
  email: string | null,
  step = 1,
): ProgressEnrollment => ({
  status,
  current_node_id: node,
  current_step_index: step,
  email,
});

console.log("collectNodeIds");
eq(collectNodeIds(GRAPH.nodes).sort(), ["c1", "e1", "e2", "notify", "w1"], "all node ids incl. both branches");

console.log("computeFlowProgress, rollup + occupancy");
{
  const replies = new Map<string, ReplyClass | null>([
    ["peeled@x.com", "true_interest"], // interested → positive
    ["obj@x.com", "objection_price"], // replied, not positive
  ]);
  const enrollments: ProgressEnrollment[] = [
    enr("active", "e1", "a@x.com", 1), // parked at e1
    enr("active", "e1", "b@x.com", 1), // parked at e1
    enr("active", "e2", "c@x.com", 2), // parked at e2 (follow-up)
    enr("replied", "notify", "peeled@x.com", 1), // peeled to notify, interested reply
    enr("active", "notify", "obj@x.com", 1), // at notify, objection reply
    enr("completed", "e2", "d@x.com", 2), // finished at e2
    enr("failed", "e1", "e@x.com", 1), // failed at e1
    enr("active", null, "f@x.com", 0), // queued, not started
  ];
  const p = computeFlowProgress(GRAPH, enrollments, replies);

  eq(p.rollup.enrolled, 8, "enrolled = 8");
  eq(p.rollup.active, 5, "active = 5");
  eq(p.rollup.completed, 1, "completed = 1");
  eq(p.rollup.replied, 1, "status=replied = 1");
  eq(p.rollup.failed, 1, "failed = 1");
  eq(p.rollup.notStarted, 1, "notStarted = 1 (active, null node)");
  eq(p.rollup.repliedContacts, 2, "repliedContacts = 2 (from lead_replies)");
  eq(p.rollup.positiveContacts, 1, "positiveContacts = 1 (interested class)");
  eq(p.rollup.replyRatePct, 25, "reply rate = 2/8 = 25%");
  eq(p.rollup.positiveRatePct, 12.5, "positive rate = 1/8 = 12.5%");

  eq(p.byNode["e1"], { active: 2, total: 3 }, "e1: 2 active of 3 total (1 failed)");
  eq(p.byNode["e2"], { active: 1, total: 2 }, "e2: 1 active of 2 total (1 completed)");
  eq(p.byNode["notify"], { active: 1, total: 2 }, "notify: 1 active of 2 total (1 replied)");

  // Branch splits via subtreeActive.
  const cond = GRAPH.nodes[1];
  if (cond.kind !== "condition") throw new Error("expected condition");
  eq(subtreeActive(cond.yes, p.byNode), 1, "YES subtree (notify) active = 1");
  eq(subtreeActive(cond.no, p.byNode), 1, "NO subtree (w1,e2) active = 1");
}

console.log("computeFlowProgress, empty");
{
  const p = computeFlowProgress(GRAPH, [], new Map());
  eq(p.rollup.enrolled, 0, "empty → enrolled 0");
  eq(p.rollup.replyRatePct, 0, "empty → 0% (no divide-by-zero)");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
