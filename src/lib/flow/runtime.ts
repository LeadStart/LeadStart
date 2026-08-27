// Flow graph — runtime walker (graph-runtime phase #3).
//
// The native sender used to execute only the derived linear `campaign_steps`
// (graphToSteps). This module makes it walk the authored `flow_graph` tree
// directly, so condition / linkedin / internal nodes actually run. It is a PURE
// function of (graph, position, signals) → next action — no IO, no dates, no
// Supabase — so the cron can unit-test the branch logic exhaustively and the
// side-effecting bits (send / task / notify) stay in run-native-sequences.
//
// ── Position model ───────────────────────────────────────────────────────────
// An enrollment's position is `current_node_id` = the graph node whose action it
// LAST executed (email sent / linkedin task created / internal notify fired), or
// NULL before the first action. `current_step_index` keeps counting EMAILS sent
// (0 = first touch) so the send machinery (subject threading, new-leads cap,
// sticky mailbox) is unchanged; only email nodes bump it.
//
// Each tick we resume AFTER current_node_id and walk forward, ACCUMULATING wait
// days and ROUTING through conditions, until we reach the next actionable node
// (email/linkedin/internal) or the end. Conditions and waits are re-traversed
// every tick (lazy) so a reply that lands mid-wait re-routes at the next tick.
// current_node_id only advances to an action node when that action actually
// fires — never past a condition — which is what makes the routing self-heal.
//
// This preserves the linear cadence exactly: the accumulated wait to the next
// email equals graphToSteps' accumulated wait_days for that step (both walk the
// primary path summing wait nodes across skipped nodes). One ACTION per due tick.
//
// ── Condition semantics (PRE-DECIDED — see run-native-sequences for the full
//    reconciliation with the global reply-halt) ───────────────────────────────
//   replied  → yes iff the contact replied (contact.status==='replied' OR a
//              lead_replies row for this campaign+contact); else no.
//   bounced  → yes iff the contact bounced (contact.status==='bounced'); else no.
//   opened   → NO branch, always. Open tracking is OFF by default (deliberate,
//   clicked  → NO branch, always. link tracking OFF too) so there is no reliable
//   manual   → NO branch, always. no automatic signal — a human decision we don't
//              model. Fail-safe: never peel a lead on a signal we can't measure.
// The three untracked triggers are flagged "needs tracking" in the builder
// (isUntrackedTrigger) so an author knows their YES arm will not fire.

import {
  flattenPrimaryPath,
  type FlowGraph,
  type FlowNode,
  type EmailNode,
  type LinkedInNode,
  type InternalNode,
  type ConditionNode,
  type FlowConditionTrigger,
} from "./graph";

// ── Signals + actions ────────────────────────────────────────────────────────

/** The measurable per-(campaign,contact) signals a condition can branch on. */
export interface FlowSignals {
  hasReplied: boolean;
  hasBounced: boolean;
}

/**
 * The next thing the sender should do for an enrollment this tick.
 *  - email/linkedin/internal: the actionable node reached, plus the wait days
 *    accumulated from the resume point (the cron gates the action on
 *    reference_time + waitDays before performing it), plus the set of condition
 *    triggers traversed to reach it (drives the reply-halt reconciliation).
 *  - complete: the walk ran off the end of the tree (or the parked node was
 *    deleted / the enrollment is past the graph) — mark the enrollment completed.
 */
export type FlowRuntimeAction =
  | { type: "email"; node: EmailNode; waitDays: number; passedTriggers: Set<FlowConditionTrigger> }
  | { type: "linkedin"; node: LinkedInNode; waitDays: number; passedTriggers: Set<FlowConditionTrigger> }
  | { type: "internal"; node: InternalNode; waitDays: number; passedTriggers: Set<FlowConditionTrigger> }
  | { type: "complete" };

/** An enrollment's position in the graph, as stored on campaign_enrollments. */
export interface FlowPosition {
  /** current_node_id — the node last acted on, or null before the first action. */
  currentNodeId: string | null;
  /** current_step_index — # of emails sent so far (0 = none). */
  emailsSent: number;
}

// ── Untracked triggers (no automatic signal) ─────────────────────────────────

export const UNTRACKED_TRIGGERS: readonly FlowConditionTrigger[] = [
  "opened",
  "clicked",
  "manual",
];

/** True for triggers we cannot measure — their YES arm never fires at runtime. */
export function isUntrackedTrigger(t: FlowConditionTrigger): boolean {
  return UNTRACKED_TRIGGERS.includes(t);
}

/** Evaluate a condition: true → take YES, false → take NO. */
export function evalCondition(
  trigger: FlowConditionTrigger,
  signals: FlowSignals,
): boolean {
  switch (trigger) {
    case "replied":
      return signals.hasReplied;
    case "bounced":
      return signals.hasBounced;
    // opened / clicked / manual: no reliable signal → NO (continue). Fail-safe.
    default:
      return false;
  }
}

// ── Primary-path helpers (shared with graphToSteps' notion of "the path") ─────

/** The email nodes on the executed primary path (every condition's NO branch). */
export function primaryEmails(graph: FlowGraph): EmailNode[] {
  return flattenPrimaryPath(graph.nodes).filter(
    (n): n is EmailNode => n.kind === "email",
  );
}

/** The first email on the primary path — the step-0 send + the "Re:" thread base. */
export function firstPrimaryEmail(graph: FlowGraph): EmailNode | null {
  return primaryEmails(graph)[0] ?? null;
}

// ── The walk ─────────────────────────────────────────────────────────────────
//
// A frame is "process list[index], list[index+1], …". Descending into a
// condition branch pushes a frame; exhausting a frame pops back to the parent's
// continuation (the sibling AFTER the condition — matching flattenPrimaryPath,
// which splices a condition's branch inline then continues the parent list).

interface Frame {
  list: FlowNode[];
  index: number;
}

/**
 * The frame stack positioned to resume JUST AFTER `id`, outermost frame first
 * (stack top = last element). Returns null when `id` is not in the tree.
 */
function stackAfter(nodes: FlowNode[], id: string): Frame[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return [{ list: nodes, index: i + 1 }];
    if (n.kind === "condition") {
      const inYes = stackAfter(n.yes, id);
      if (inYes) return [{ list: nodes, index: i + 1 }, ...inYes];
      const inNo = stackAfter(n.no, id);
      if (inNo) return [{ list: nodes, index: i + 1 }, ...inNo];
    }
  }
  return null;
}

/** Resolve the resume stack for a position, or "beyond" when past the graph. */
function resolveStack(graph: FlowGraph, pos: FlowPosition): Frame[] | "beyond" {
  if (pos.currentNodeId != null) {
    // A parked node that no longer exists (graph edited under an in-flight
    // enrollment) → treat as complete rather than restart-and-resend.
    return stackAfter(graph.nodes, pos.currentNodeId) ?? "beyond";
  }
  if (pos.emailsSent <= 0) {
    // Fresh enrollment (or a pre-migration one that never sent) → start at top.
    return [{ list: graph.nodes, index: 0 }];
  }
  // Pre-migration in-flight enrollment (current_node_id NULL but emails already
  // sent): map the linear position onto the graph. It had sent `emailsSent`
  // primary-path emails, so resume after the (emailsSent-1)-th one. No re-send.
  const anchor = primaryEmails(graph)[pos.emailsSent - 1];
  if (!anchor) return "beyond"; // graph now has fewer emails than were sent
  return stackAfter(graph.nodes, anchor.id) ?? "beyond";
}

/**
 * Resolve the next action for an enrollment. Pure: no clock, no IO. The cron
 * gates the returned action on its waitDays and performs the side effect.
 */
export function resolveFlowAction(
  graph: FlowGraph,
  pos: FlowPosition,
  signals: FlowSignals,
): FlowRuntimeAction {
  const resolved = resolveStack(graph, pos);
  if (resolved === "beyond") return { type: "complete" };

  // Clone frames so we can advance indices without mutating the caller's graph.
  const stack: Frame[] = resolved.map((f) => ({ list: f.list, index: f.index }));
  const passedTriggers = new Set<FlowConditionTrigger>();
  let waitDays = 0;

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.index >= top.list.length) {
      stack.pop();
      continue;
    }
    const node = top.list[top.index];

    if (node.kind === "wait") {
      waitDays += Number(node.wait_days) || 0;
      top.index += 1;
      continue;
    }
    if (node.kind === "condition") {
      const cond = node as ConditionNode;
      passedTriggers.add(cond.trigger);
      const takeYes = evalCondition(cond.trigger, signals);
      top.index += 1; // step past the condition first, so exhausting the chosen
      stack.push({ list: takeYes ? cond.yes : cond.no, index: 0 }); // branch rejoins here
      continue;
    }
    // Actionable node — stop here.
    if (node.kind === "email") return { type: "email", node, waitDays, passedTriggers };
    if (node.kind === "linkedin") return { type: "linkedin", node, waitDays, passedTriggers };
    return { type: "internal", node, waitDays, passedTriggers };
  }
  return { type: "complete" };
}
