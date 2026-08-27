#!/usr/bin/env node
/**
 * Unit tests for the flow-graph model (steps <-> graph, primary-path
 * derivation, validation). No network, no DB. Run: npx tsx scripts/test-flow-graph.ts
 */
import {
  stepsToGraph,
  graphToSteps,
  validateGraph,
  countEmails,
  flattenPrimaryPath,
  emailNode,
  waitNode,
  linkedinNode,
  internalNode,
  conditionNode,
  emptyGraph,
  type FlowGraph,
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

console.log("stepsToGraph");
{
  const g = stepsToGraph([
    { wait_days: 0, subject_template: "A", body_template: "x" },
    { wait_days: 3, subject_template: null, body_template: "y" },
  ]);
  eq(g.nodes.map((n) => n.kind), ["email", "wait", "email"], "wait node inserted only for wait>0");
  eq(countEmails(g), 2, "two email nodes");
}

console.log("graphToSteps — linear roundtrip");
{
  const steps = [
    { wait_days: 0, subject_template: "A", body_template: "x" },
    { wait_days: 3, subject_template: null, body_template: "y" },
    { wait_days: 5, subject_template: null, body_template: "z" },
  ];
  eq(graphToSteps(stepsToGraph(steps)), steps, "steps -> graph -> steps is identity");
}

console.log("graphToSteps — condition follows the NO branch, drops YES");
{
  const g: FlowGraph = {
    version: 1,
    nodes: [
      emailNode("Q", "b1"),
      conditionNode(
        "replied",
        [internalNode("notify", "Ping AM"), emailNode("", "peeled")],
        [waitNode(3), emailNode("", "b2")],
      ),
    ],
  };
  eq(
    graphToSteps(g),
    [
      { wait_days: 0, subject_template: "Q", body_template: "b1" },
      { wait_days: 3, subject_template: null, body_template: "b2" },
    ],
    "primary path = email then no-branch email; yes-branch email excluded",
  );
}

console.log("graphToSteps — wait accumulates across skipped linkedin/internal");
{
  const g: FlowGraph = {
    version: 1,
    nodes: [
      emailNode("Q", "b1"),
      waitNode(3),
      linkedinNode("connect_request", "hi"),
      internalNode("notify", "ping"),
      emailNode("", "b2"),
    ],
  };
  eq(
    graphToSteps(g),
    [
      { wait_days: 0, subject_template: "Q", body_template: "b1" },
      { wait_days: 3, subject_template: null, body_template: "b2" },
    ],
    "wait 3 carries to the next email past skipped nodes",
  );
}

console.log("nested condition — primary path + countEmails");
{
  const g: FlowGraph = {
    version: 1,
    nodes: [
      emailNode("Q", "b1"),
      conditionNode(
        "replied",
        [internalNode("notify", "AM")],
        [
          waitNode(3),
          emailNode("", "b2"),
          conditionNode(
            "opened",
            [waitNode(2), emailNode("", "nudge")],
            [emailNode("", "breakup")],
          ),
        ],
      ),
    ],
  };
  eq(
    graphToSteps(g).map((s) => [s.wait_days, s.body_template]),
    [
      [0, "b1"],
      [3, "b2"],
      [0, "breakup"],
    ],
    "primary path follows no -> no to the breakup email",
  );
  eq(countEmails(g), 4, "counts emails in every branch (b1,b2,nudge,breakup)");
  eq(flattenPrimaryPath(g.nodes).filter((n) => n.kind === "condition").length, 0, "conditions dropped from primary path");
}

console.log("validateGraph");
{
  eq(validateGraph(emptyGraph()), "Add at least one email step.", "empty graph");
  eq(
    validateGraph({ version: 1, nodes: [emailNode("", "body")] }),
    "The first email needs a subject line.",
    "first email missing subject",
  );
  eq(
    validateGraph({ version: 1, nodes: [emailNode("S", "")] }),
    "Email 1 needs a body.",
    "first email missing body",
  );
  eq(validateGraph({ version: 1, nodes: [emailNode("S", "b")] }), null, "valid single email");
  eq(
    validateGraph({
      version: 1,
      nodes: [emailNode("S", "b"), conditionNode("replied", [emailNode("", "")], [])],
    }),
    "Every email in the flow needs a body.",
    "branch email missing body",
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
