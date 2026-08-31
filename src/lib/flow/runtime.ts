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
// We route on INBOUND signals only (replies + bounces) — never on opens/clicks,
// which would need tracking pixels/links we deliberately don't add.
//   replied              → yes iff the contact sent a HUMAN reply (hasReplied =
//                          contact.status==='replied'; the reply poller sets this
//                          only for non-auto replies, so OOO/auto never trips it
//                          or the global halt — matching the linear sender).
//   reply_interested     → yes iff the latest reply's final_class ∈ {true_interest,
//                          meeting_booked, qualifying_question, referral_forward}.
//   reply_objection      → yes iff final_class ∈ {objection_price, objection_timing}.
//   reply_not_interested → yes iff final_class ∈ {not_interested,
//                          wrong_person_no_referral, unsubscribe}.
//   reply_ooo            → yes iff final_class === 'ooo' (matches an auto-reply
//                          even though hasReplied is false → route it without halting).
//   bounced              → yes iff the contact bounced.
//   opened/clicked/manual→ NO branch, ALWAYS. No signal (tracking off / no
//                          automation). Retired from the builder; kept only so
//                          legacy stored graphs still load. isUntrackedTrigger.
// When a reply-family condition MATCHES (takes yes), the walk sets
// matchedReplyRoute so the sender knows the author is handling that reply and the
// global reply-halt stands down — but an UNHANDLED reply class still halts (a
// replied contact is never emailed again unless a matching branch routes them).

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
import type { ReplyClass } from "@/types/app";

// ── Signals + actions ────────────────────────────────────────────────────────

/** The measurable per-(campaign,contact) signals a condition can branch on. */
export interface FlowSignals {
  hasReplied: boolean;
  hasBounced: boolean;
  /** The classifier's final_class for the latest reply; null if none/unclassified. */
  replyClass: ReplyClass | null;
}

/**
 * The next thing the sender should do for an enrollment this tick.
 *  - email/linkedin/internal: the actionable node reached, the wait days
 *    accumulated from the resume point (the cron gates the action on
 *    reference_time + waitDays before performing it), and matchedReplyRoute —
 *    true when a reply-family condition MATCHED en route, which stands the global
 *    reply-halt down (the graph is handling the reply).
 *  - complete: the walk ran off the end of the tree (or the parked node was
 *    deleted / the enrollment is past the graph) — mark the enrollment completed.
 */
export type FlowRuntimeAction =
  | { type: "email"; node: EmailNode; waitDays: number; matchedReplyRoute: boolean }
  | { type: "linkedin"; node: LinkedInNode; waitDays: number; matchedReplyRoute: boolean }
  | { type: "internal"; node: InternalNode; waitDays: number; matchedReplyRoute: boolean }
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

// Reply-family triggers route on an inbound reply (existence or class). When one
// MATCHES (evaluates true), the walk records matchedReplyRoute so the sender's
// global reply-halt stands down — the author is handling that reply.
export const REPLY_TRIGGERS: readonly FlowConditionTrigger[] = [
  "replied",
  "reply_interested",
  "reply_objection",
  "reply_not_interested",
  "reply_ooo",
];

/** True for the reply-family triggers (any-reply + the sentiment classes). */
export function isReplyTrigger(t: FlowConditionTrigger): boolean {
  return REPLY_TRIGGERS.includes(t);
}

// Sentiment groups over the classifier's ReplyClass. "interested" mirrors
// HOT_REPLY_CLASSES (the call-now classes). `referral_forward` and
// `needs_review` match NO group, so only a plain `replied` condition catches
// them: a handoff is not the prospect being interested, and an ambiguous reply
// shouldn't auto-route, so neither steers the interested/objection branches.
const INTERESTED_CLASSES: readonly ReplyClass[] = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
];
const OBJECTION_CLASSES: readonly ReplyClass[] = ["objection_price", "objection_timing"];
const NOT_INTERESTED_CLASSES: readonly ReplyClass[] = [
  "not_interested",
  "wrong_person_no_referral",
  "unsubscribe",
];

/** Which sentiment group a reply class falls in (null = none, e.g. needs_review). */
export function replyClassGroup(
  cls: ReplyClass | null,
): "interested" | "objection" | "not_interested" | "ooo" | null {
  if (cls == null) return null;
  if (INTERESTED_CLASSES.includes(cls)) return "interested";
  if (OBJECTION_CLASSES.includes(cls)) return "objection";
  if (NOT_INTERESTED_CLASSES.includes(cls)) return "not_interested";
  if (cls === "ooo") return "ooo";
  return null;
}

/** Evaluate a condition: true → take YES, false → take NO. */
export function evalCondition(
  trigger: FlowConditionTrigger,
  signals: FlowSignals,
): boolean {
  const group = replyClassGroup(signals.replyClass);
  switch (trigger) {
    case "replied":
      return signals.hasReplied;
    case "bounced":
      return signals.hasBounced;
    // Sentiment triggers key on the reply CLASS (from lead_replies), NOT the
    // human-reply flag: reply_ooo must be able to match an out-of-office
    // auto-reply, which correctly does NOT set hasReplied / halt the sequence.
    // A non-null class means a reply of that class was ingested for this campaign.
    case "reply_interested":
      return group === "interested";
    case "reply_objection":
      return group === "objection";
    case "reply_not_interested":
      return group === "not_interested";
    case "reply_ooo":
      return group === "ooo";
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
  let matchedReplyRoute = false;
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
      const takeYes = evalCondition(cond.trigger, signals);
      // A reply-family condition that MATCHED means the author is handling this
      // reply → the sender's global reply-halt stands down (run-native-sequences).
      if (takeYes && isReplyTrigger(cond.trigger)) matchedReplyRoute = true;
      top.index += 1; // step past the condition first, so exhausting the chosen
      stack.push({ list: takeYes ? cond.yes : cond.no, index: 0 }); // branch rejoins here
      continue;
    }
    // Actionable node — stop here.
    if (node.kind === "email") return { type: "email", node, waitDays, matchedReplyRoute };
    if (node.kind === "linkedin") return { type: "linkedin", node, waitDays, matchedReplyRoute };
    return { type: "internal", node, waitDays, matchedReplyRoute };
  }
  return { type: "complete" };
}
