// Flow observability — turn a campaign's live enrollments into a per-node
// occupancy map + a rollup, so an operator can SEE the branching working (who
// peeled off, who's still in follow-up, the reply / positive-reply rates).
//
// Pure: (graph + enrollments + reply signal) → numbers. No IO. The sender stamps
// campaign_enrollments.current_node_id (the node an enrollment last acted on), so
// "occupancy at node X" = enrollments parked at X. Conditions never hold an
// enrollment (they route), so a condition's branch split is derived by the UI
// summing occupancy over each branch's subtree (collectNodeIds).

import { walkAll, type FlowGraph, type FlowNode } from "./graph";
import { replyClassGroup } from "./runtime";
import type { ReplyClass } from "@/types/app";

export interface ProgressEnrollment {
  current_node_id: string | null;
  current_step_index: number | null;
  status: string; // active | completed | replied | failed | paused
  email: string | null;
}

export interface FlowProgressData {
  rollup: {
    enrolled: number;
    active: number;
    completed: number;
    replied: number; // enrollment status='replied' (halted on an unhandled reply)
    failed: number;
    paused: number;
    notStarted: number; // active, no node yet (queued at the start)
    repliedContacts: number; // true reply count from lead_replies
    positiveContacts: number; // interested-class replies
    replyRatePct: number; // repliedContacts / enrolled
    positiveRatePct: number; // positiveContacts / enrolled
  };
  /** Per node id: enrollments whose current_node_id === id, by liveness. */
  byNode: Record<string, { active: number; total: number }>;
}

/** All node ids in a node list's subtree (both branches of every condition). */
export function collectNodeIds(nodes: FlowNode[]): string[] {
  const ids: string[] = [];
  walkAll(nodes, (n) => ids.push(n.id));
  return ids;
}

const ROLLUP_STATUSES = ["active", "completed", "replied", "failed", "paused"] as const;

export function computeFlowProgress(
  graph: FlowGraph,
  enrollments: ProgressEnrollment[],
  replyByEmail: Map<string, ReplyClass | null>,
): FlowProgressData {
  const rollup = {
    enrolled: 0,
    active: 0,
    completed: 0,
    replied: 0,
    failed: 0,
    paused: 0,
    notStarted: 0,
    repliedContacts: 0,
    positiveContacts: 0,
    replyRatePct: 0,
    positiveRatePct: 0,
  };
  const byNode: Record<string, { active: number; total: number }> = {};

  for (const e of enrollments) {
    rollup.enrolled += 1;
    if ((ROLLUP_STATUSES as readonly string[]).includes(e.status)) {
      rollup[e.status as (typeof ROLLUP_STATUSES)[number]] += 1;
    }

    // Reply outcome (from lead_replies — the true reply count, independent of the
    // enrollment status, since a matching reply-condition routes without halting).
    const email = e.email?.trim().toLowerCase();
    if (email && replyByEmail.has(email)) {
      rollup.repliedContacts += 1;
      if (replyClassGroup(replyByEmail.get(email) ?? null) === "interested") {
        rollup.positiveContacts += 1;
      }
    }

    // Node occupancy.
    if (e.current_node_id) {
      const slot = (byNode[e.current_node_id] ??= { active: 0, total: 0 });
      slot.total += 1;
      if (e.status === "active") slot.active += 1;
    } else if (e.status === "active") {
      rollup.notStarted += 1;
    }
  }

  const denom = rollup.enrolled || 1;
  rollup.replyRatePct = Math.round((rollup.repliedContacts / denom) * 1000) / 10;
  rollup.positiveRatePct = Math.round((rollup.positiveContacts / denom) * 1000) / 10;
  return { rollup, byNode };
}

/** Sum active occupancy over a node subtree — the count "flowing through" a branch. */
export function subtreeActive(
  nodes: FlowNode[],
  byNode: FlowProgressData["byNode"],
): number {
  return collectNodeIds(nodes).reduce((sum, id) => sum + (byNode[id]?.active ?? 0), 0);
}
