// Immutable tree edits for the Flow builder. Every helper returns a new node
// array (never mutates) so React state updates stay predictable. Nodes are
// addressed by id, recursing into both branches of every condition.

import type { FlowNode, ConditionNode } from "./graph";

/** Shallow-merge a patch into the node with the given id, anywhere in the tree. */
export function updateNode(
  nodes: FlowNode[],
  id: string,
  patch: Record<string, unknown>,
): FlowNode[] {
  return nodes.map((n) => {
    if (n.id === id) return { ...n, ...patch } as FlowNode;
    if (n.kind === "condition") {
      return {
        ...n,
        yes: updateNode(n.yes, id, patch),
        no: updateNode(n.no, id, patch),
      };
    }
    return n;
  });
}

/** Remove the node with the given id, anywhere in the tree. */
export function removeNode(nodes: FlowNode[], id: string): FlowNode[] {
  const out: FlowNode[] = [];
  for (const n of nodes) {
    if (n.id === id) continue;
    if (n.kind === "condition") {
      out.push({ ...n, yes: removeNode(n.yes, id), no: removeNode(n.no, id) });
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Insert `node` immediately after the node with id `afterId`. */
export function insertAfter(
  nodes: FlowNode[],
  afterId: string,
  node: FlowNode,
): FlowNode[] {
  const out: FlowNode[] = [];
  for (const n of nodes) {
    out.push(
      n.kind === "condition"
        ? {
            ...n,
            yes: insertAfter(n.yes, afterId, node),
            no: insertAfter(n.no, afterId, node),
          }
        : n,
    );
    if (n.id === afterId) out.push(node);
  }
  return out;
}

/** Append `node` to the `yes` or `no` branch of the condition with id `condId`. */
export function appendToBranch(
  nodes: FlowNode[],
  condId: string,
  branch: "yes" | "no",
  node: FlowNode,
): FlowNode[] {
  return nodes.map((n) => {
    if (n.kind !== "condition") return n;
    if (n.id === condId) {
      const c = n as ConditionNode;
      return { ...c, [branch]: [...c[branch], node] } as ConditionNode;
    }
    return {
      ...n,
      yes: appendToBranch(n.yes, condId, branch, node),
      no: appendToBranch(n.no, condId, branch, node),
    };
  });
}
