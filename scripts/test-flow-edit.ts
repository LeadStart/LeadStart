#!/usr/bin/env node
/**
 * Unit tests for the immutable flow-tree edits. No network, no DB.
 * Run: npx tsx scripts/test-flow-edit.ts
 */
import { updateNode, removeNode, insertAfter, appendToBranch } from "../src/lib/flow/edit.ts";
import { emailNode, waitNode, conditionNode, type FlowNode, type EmailNode } from "../src/lib/flow/graph.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
const bodyOf = (nodes: FlowNode[], id: string): string | undefined => {
  for (const n of nodes) {
    if (n.id === id && n.kind === "email") return (n as EmailNode).body;
    if (n.kind === "condition") {
      const y = bodyOf(n.yes, id);
      if (y !== undefined) return y;
      const no = bodyOf(n.no, id);
      if (no !== undefined) return no;
    }
  }
  return undefined;
};

// Build: email(e1) -> condition(c1){ yes:[email(y1)], no:[email(n1)] }
const e1 = emailNode("S", "b1", "e1");
const y1 = emailNode("", "yes-body", "y1");
const n1 = emailNode("", "no-body", "n1");
const c1 = conditionNode("replied", [y1], [n1], "c1");
const tree: FlowNode[] = [e1, c1];

console.log("updateNode");
{
  const t = updateNode(tree, "e1", { body: "EDITED" });
  ok(bodyOf(t, "e1") === "EDITED", "patches a top-level node");
  ok(bodyOf(tree, "e1") === "b1", "original tree is untouched (immutable)");
  const t2 = updateNode(tree, "y1", { body: "Y2" });
  ok(bodyOf(t2, "y1") === "Y2", "patches a node inside a yes branch");
}

console.log("removeNode");
{
  const t = removeNode(tree, "n1");
  ok(bodyOf(t, "n1") === undefined, "removes a node inside the no branch");
  ok(bodyOf(t, "y1") === "yes-body", "leaves the sibling branch intact");
  const t2 = removeNode(tree, "c1");
  ok(t2.length === 1 && t2[0].id === "e1", "removes the whole condition subtree");
}

console.log("insertAfter");
{
  const w = waitNode(2, "w1");
  const t = insertAfter(tree, "e1", w);
  ok(t.length === 3 && t[1].id === "w1", "inserts immediately after a top-level node");
  const t2 = insertAfter(tree, "n1", emailNode("", "x", "x1"));
  const cond = t2.find((n) => n.id === "c1");
  ok(
    cond?.kind === "condition" && cond.no.length === 2 && cond.no[1].id === "x1",
    "inserts after a node deep inside a branch",
  );
}

console.log("appendToBranch");
{
  const t = appendToBranch(tree, "c1", "yes", emailNode("", "z", "z1"));
  const cond = t.find((n) => n.id === "c1");
  ok(cond?.kind === "condition" && cond.yes.length === 2 && cond.yes[1].id === "z1", "appends to the yes branch");
  const t2 = appendToBranch(tree, "c1", "no", waitNode(9, "w9"));
  const cond2 = t2.find((n) => n.id === "c1");
  ok(cond2?.kind === "condition" && cond2.no[cond2.no.length - 1].id === "w9", "appends to the no branch");
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
