#!/usr/bin/env node
/**
 * Unit tests for the flow-graph runtime walker (src/lib/flow/runtime.ts).
 * Pure function: no network, no DB, no clock. Run:
 *   npx tsx scripts/test-flow-runtime.ts
 *
 * Covers: fresh start, wait accumulation, top-level + nested conditions (both
 * branches), reply-CLASS sentiment routing + the matchedReplyRoute safety flag,
 * untracked-trigger fail-safe, linkedin/internal side-effects, rejoin-after-
 * condition (matches graphToSteps), the legacy-linear graph, pre-migration
 * NULL→node resolution, and the complete/edge cases.
 */
import {
  resolveFlowAction,
  evalCondition,
  isUntrackedTrigger,
  isReplyTrigger,
  replyClassGroup,
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

// Signal fixtures. A reply with a class implies hasReplied.
const NONE: FlowSignals = { hasReplied: false, hasBounced: false, replyClass: null };
const REPLIED_ANY: FlowSignals = { hasReplied: true, hasBounced: false, replyClass: null };
const INTERESTED: FlowSignals = { hasReplied: true, hasBounced: false, replyClass: "true_interest" };
const OBJECTION: FlowSignals = { hasReplied: true, hasBounced: false, replyClass: "objection_price" };
const NOT_INT: FlowSignals = { hasReplied: true, hasBounced: false, replyClass: "not_interested" };
// An out-of-office is an AUTO reply — the poller doesn't set contact.status, so
// hasReplied is false, but its class is still ingested (replyClass 'ooo').
const OOO: FlowSignals = { hasReplied: false, hasBounced: false, replyClass: "ooo" };
const BOUNCED: FlowSignals = { hasReplied: false, hasBounced: true, replyClass: null };

const g = (nodes: FlowNode[]): FlowGraph => ({ version: 1, nodes });

/** Compact, comparable view of an action. */
function info(a: FlowRuntimeAction) {
  if (a.type === "complete") return { type: "complete" };
  return { type: a.type, id: a.node.id, waitDays: a.waitDays, matched: a.matchedReplyRoute };
}

// ── evalCondition + trigger helpers ──────────────────────────────────────────
console.log("evalCondition — inbound-signal semantics");
eq(evalCondition("replied", REPLIED_ANY), true, "replied + any reply → yes");
eq(evalCondition("replied", INTERESTED), true, "replied + a classified reply → yes (any)");
eq(evalCondition("replied", NONE), false, "replied + no reply → no");
eq(evalCondition("bounced", BOUNCED), true, "bounced + hasBounced → yes");
eq(evalCondition("bounced", NONE), false, "bounced + not → no");
eq(evalCondition("opened", REPLIED_ANY), false, "opened → no (retired, no signal)");
eq(evalCondition("clicked", BOUNCED), false, "clicked → no (retired)");
eq(evalCondition("manual", REPLIED_ANY), false, "manual → no (retired)");

console.log("evalCondition — reply-class sentiment groups");
eq(evalCondition("reply_interested", INTERESTED), true, "reply_interested + interested class → yes");
eq(evalCondition("reply_interested", OBJECTION), false, "reply_interested + objection class → no");
eq(evalCondition("reply_interested", REPLIED_ANY), false, "reply_interested + unclassified reply → no");
eq(evalCondition("reply_interested", NONE), false, "reply_interested + no reply → no");
eq(evalCondition("reply_objection", OBJECTION), true, "reply_objection + objection class → yes");
eq(evalCondition("reply_objection", INTERESTED), false, "reply_objection + interested class → no");
eq(evalCondition("reply_not_interested", NOT_INT), true, "reply_not_interested + not_interested → yes");
eq(evalCondition("reply_ooo", OOO), true, "reply_ooo + ooo → yes (matches on class, not hasReplied)");
eq(evalCondition("reply_ooo", INTERESTED), false, "reply_ooo + interested → no");
eq(evalCondition("replied", OOO), false, "replied + OOO auto-reply → NO (not a human reply → never halts)");
eq(evalCondition("reply_interested", OOO), false, "reply_interested + OOO → no");

console.log("trigger helpers + class grouping");
eq(isUntrackedTrigger("opened"), true, "opened is untracked");
eq(isUntrackedTrigger("replied"), false, "replied is tracked");
eq(isReplyTrigger("replied"), true, "replied is a reply trigger");
eq(isReplyTrigger("reply_objection"), true, "reply_objection is a reply trigger");
eq(isReplyTrigger("bounced"), false, "bounced is not a reply trigger");
eq(isReplyTrigger("opened"), false, "opened is not a reply trigger");
eq(replyClassGroup("meeting_booked"), "interested", "meeting_booked → interested");
eq(replyClassGroup("objection_timing"), "objection", "objection_timing → objection");
eq(replyClassGroup("unsubscribe"), "not_interested", "unsubscribe → not_interested");
eq(replyClassGroup("ooo"), "ooo", "ooo → ooo");
eq(replyClassGroup("needs_review"), null, "needs_review → no group");
// referral is owner-facing, NOT interested: a handoff must not route down the
// interested branch (owner call 2026-08-31). Locks it out of every group.
eq(replyClassGroup("referral_forward"), null, "referral_forward → no group (not interested)");
eq(replyClassGroup(null), null, "null class → no group");

// ── Fresh start + wait accumulation ──────────────────────────────────────────
console.log("fresh start + wait accumulation");
{
  const graph = g([emailNode("Hi", "b", "e1")]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: null, emailsSent: 0 }, NONE)),
    { type: "email", id: "e1", waitDays: 0, matched: false },
    "fresh enrollment → first email, wait 0",
  );
}
{
  const graph = g([waitNode(2, "w0"), emailNode("Hi", "b", "e1")]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: null, emailsSent: 0 }, NONE)),
    { type: "email", id: "e1", waitDays: 2, matched: false },
    "leading wait → first email waits 2",
  );
}
{
  const graph = g([
    emailNode("Hi", "b", "e1"),
    waitNode(2, "w1"),
    waitNode(3, "w2"),
    emailNode("", "b2", "e2"),
  ]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, NONE)),
    { type: "email", id: "e2", waitDays: 5, matched: false },
    "after e1 → e2 with accumulated wait 2+3=5",
  );
}

// ── Top-level condition (replied), both branches (lazy re-eval) ──────────────
console.log("top-level 'replied' condition — both branches");
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
    info(resolveFlowAction(graph, pos, NONE)),
    { type: "email", id: "e2", waitDays: 3, matched: false },
    "not replied → NO → e2 (matched=false)",
  );
  eq(
    info(resolveFlowAction(graph, pos, REPLIED_ANY)),
    { type: "internal", id: "int1", waitDays: 0, matched: true },
    "replied → YES → notify (matchedReplyRoute=true)",
  );
}

// ── Reply-CLASS routing + the safety flag ────────────────────────────────────
console.log("reply-class routing (sentiment groups)");
{
  // If interested → peel to notify; else keep sending.
  const graph = g([
    emailNode("Hi", "b", "e1"),
    conditionNode(
      "reply_interested",
      [internalNode("notify", "Hot lead", "int1")],
      [waitNode(2, "w1"), emailNode("", "b2", "e2")],
      "c1",
    ),
  ]);
  const pos = { currentNodeId: "e1", emailsSent: 1 };
  eq(
    info(resolveFlowAction(graph, pos, INTERESTED)),
    { type: "internal", id: "int1", waitDays: 0, matched: true },
    "interested reply → YES → notify (matched=true)",
  );
  eq(
    info(resolveFlowAction(graph, pos, OBJECTION)),
    { type: "email", id: "e2", waitDays: 2, matched: false },
    "objection reply → NO → e2 but matched=FALSE (unhandled class → sender will halt, safe)",
  );
  eq(
    info(resolveFlowAction(graph, pos, NONE)),
    { type: "email", id: "e2", waitDays: 2, matched: false },
    "no reply → NO → e2 (matched=false)",
  );
}
{
  // Chain the sentiment classes: interested→peel, objection→nurture, else continue.
  const graph = g([
    emailNode("Hi", "b", "e1"),
    conditionNode(
      "reply_interested",
      [internalNode("notify", "peel", "peel")],
      [
        conditionNode(
          "reply_objection",
          [emailNode("Re", "nurture", "nurtureEmail")],
          [emailNode("", "continue", "e2")],
          "c2",
        ),
      ],
      "c1",
    ),
  ]);
  const pos = { currentNodeId: "e1", emailsSent: 1 };
  eq(
    info(resolveFlowAction(graph, pos, INTERESTED)),
    { type: "internal", id: "peel", waitDays: 0, matched: true },
    "interested → outer YES → peel (matched=true)",
  );
  eq(
    info(resolveFlowAction(graph, pos, OBJECTION)),
    { type: "email", id: "nurtureEmail", waitDays: 0, matched: true },
    "objection → inner YES → nurture email (matched=true — author is handling it)",
  );
  eq(
    info(resolveFlowAction(graph, pos, NOT_INT)),
    { type: "email", id: "e2", waitDays: 0, matched: false },
    "not-interested (unhandled class) → both NO → e2, matched=FALSE (sender halts)",
  );
}

// ── Out-of-office handling (auto-reply must not halt) ────────────────────────
console.log("out-of-office routing (auto-reply never halts)");
{
  // reply_ooo can route an OOO (e.g. wait longer, then resume).
  const graph = g([
    emailNode("Hi", "b", "e1"),
    conditionNode(
      "reply_ooo",
      [waitNode(5, "w"), emailNode("Re", "resume", "resume")],
      [emailNode("", "cont", "e2")],
      "c1",
    ),
  ]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, OOO)),
    { type: "email", id: "resume", waitDays: 5, matched: true },
    "OOO → reply_ooo YES → wait 5 + resume (matched=true; hasReplied=false so no halt either way)",
  );
}
{
  // A plain `replied` condition ignores an OOO (not a human reply) → No branch,
  // matched=false, and hasReplied=false so the sender does NOT halt: the sequence
  // continues through an out-of-office rather than treating it as engagement.
  const graph = g([
    emailNode("Hi", "b", "e1"),
    conditionNode("replied", [internalNode("notify", "n", "int")], [emailNode("", "cont", "e2")], "c1"),
  ]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, OOO)),
    { type: "email", id: "e2", waitDays: 0, matched: false },
    "OOO → plain `replied` does NOT match → continues (no false peel-off)",
  );
}

// ── Nested condition with a non-reply inner (bounced) ────────────────────────
console.log("nested condition (reply outer, bounce inner)");
{
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
    info(resolveFlowAction(graph, pos, NONE)),
    { type: "email", id: "e2", waitDays: 0, matched: false },
    "not replied, not bounced → inner NO → e2 (matched=false)",
  );
  eq(
    info(resolveFlowAction(graph, pos, BOUNCED)),
    { type: "internal", id: "int2", waitDays: 0, matched: false },
    "bounced → inner YES → notify; matched stays FALSE (bounce isn't a reply trigger)",
  );
  eq(
    info(resolveFlowAction(graph, pos, REPLIED_ANY)),
    { type: "email", id: "eYes", waitDays: 0, matched: true },
    "replied → outer YES → eYes (matched=true)",
  );
}

// ── Retired trigger always takes NO ──────────────────────────────────────────
console.log("retired trigger routing");
{
  const graph = g([
    emailNode("Hi", "b", "e1"),
    conditionNode("opened", [emailNode("", "y", "eY")], [emailNode("", "n", "eN")], "c1"),
  ]);
  const pos = { currentNodeId: "e1", emailsSent: 1 };
  eq(
    info(resolveFlowAction(graph, pos, NONE)),
    { type: "email", id: "eN", waitDays: 0, matched: false },
    "opened → NO (no signal)",
  );
  eq(
    info(resolveFlowAction(graph, pos, INTERESTED)),
    { type: "email", id: "eN", waitDays: 0, matched: false },
    "opened → NO even for an interested reply (retired ignores signals)",
  );
}

// ── LinkedIn side-effect node ────────────────────────────────────────────────
console.log("linkedin side-effect node");
{
  const graph = g([
    emailNode("Hi", "b", "e1"),
    waitNode(1, "w1"),
    linkedinNode("connect_request", "connect", "li1"),
    emailNode("", "after", "e2"),
  ]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, NONE)),
    { type: "linkedin", id: "li1", waitDays: 1, matched: false },
    "after e1 → linkedin task (wait 1)",
  );
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "li1", emailsSent: 1 }, NONE)),
    { type: "email", id: "e2", waitDays: 0, matched: false },
    "after linkedin → e2",
  );
}

// ── Rejoin after a condition (matches graphToSteps) ──────────────────────────
console.log("rejoin after condition");
{
  const graph = g([
    emailNode("A", "b", "e1"),
    conditionNode("replied", [emailNode("", "y", "eYes")], [emailNode("", "n", "eNo")], "c1"),
    emailNode("", "b3", "e3"),
  ]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, NONE)),
    { type: "email", id: "eNo", waitDays: 0, matched: false },
    "after e1, not replied → eNo",
  );
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "eNo", emailsSent: 2 }, NONE)),
    { type: "email", id: "e3", waitDays: 0, matched: false },
    "after eNo → rejoins parent spine to e3",
  );
  eq(primaryEmails(graph).map((n) => n.id), ["e1", "eNo", "e3"], "primaryEmails: e1, eNo, e3");
  eq(graphToSteps(graph).length, 3, "graphToSteps agrees: 3 emails on the primary path");
}

// ── Legacy-linear graph walks identically to graphToSteps ────────────────────
console.log("legacy-linear graph reproduces the linear sequence");
{
  const graph = stepsToGraph([
    { wait_days: 0, subject_template: "S0", body_template: "b0" },
    { wait_days: 3, subject_template: null, body_template: "b1" },
    { wait_days: 2, subject_template: null, body_template: "b2" },
  ]);
  const emails = primaryEmails(graph);
  const seq: { id: string; waitDays: number }[] = [];
  let pos = { currentNodeId: null as string | null, emailsSent: 0 };
  for (let guard = 0; guard < 10; guard++) {
    const a = resolveFlowAction(graph, pos, NONE);
    if (a.type === "complete") break;
    if (a.type !== "email") throw new Error("linear graph produced a non-email action");
    seq.push({ id: a.node.id, waitDays: a.waitDays });
    pos = { currentNodeId: a.node.id, emailsSent: pos.emailsSent + 1 };
  }
  eq(seq.map((s) => s.waitDays), [0, 3, 2], "walker cadence matches the linear steps (0,3,2)");
  eq(seq.map((s) => s.id), emails.map((e) => e.id), "walker visits the 3 emails in order");
}

// ── Pre-migration NULL→node resolution (no re-send) ──────────────────────────
console.log("pre-migration in-flight resolution");
{
  const graph = g([
    emailNode("S0", "b0", "e1"),
    waitNode(3, "w1"),
    emailNode("", "b1", "e2"),
    waitNode(2, "w2"),
    emailNode("", "b2", "e3"),
  ]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: null, emailsSent: 2 }, NONE)),
    { type: "email", id: "e3", waitDays: 2, matched: false },
    "emailsSent=2 → resumes at e3 (after e2), no re-send",
  );
  eq(
    info(resolveFlowAction(graph, { currentNodeId: null, emailsSent: 9 }, NONE)),
    { type: "complete" },
    "emailsSent beyond the graph → complete",
  );
}

// ── Complete / edge cases ────────────────────────────────────────────────────
console.log("complete + edge cases");
{
  const graph = g([emailNode("Hi", "b", "e1")]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, NONE)),
    { type: "complete" },
    "after the last node → complete",
  );
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "ghost", emailsSent: 1 }, NONE)),
    { type: "complete" },
    "parked node deleted → complete (no restart)",
  );
  eq(
    info(resolveFlowAction(g([]), { currentNodeId: null, emailsSent: 0 }, NONE)),
    { type: "complete" },
    "empty graph → complete",
  );
}
{
  const graph = g([
    emailNode("Hi", "b", "e1"),
    conditionNode("replied", [], [emailNode("", "n", "e2")], "c1"),
  ]);
  eq(
    info(resolveFlowAction(graph, { currentNodeId: "e1", emailsSent: 1 }, REPLIED_ANY)),
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
