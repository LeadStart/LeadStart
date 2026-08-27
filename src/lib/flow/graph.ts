// Flow graph — the data model behind the visual campaign builder.
//
// A campaign sequence is a recursive tree of nodes. Most nodes sit on a single
// spine; a `condition` node forks the spine into a `yes` branch (peel-off, e.g.
// a replier handed to the account manager) and a `no` branch (everyone else
// continues). Email + wait nodes are the only ones the native sender executes
// today; linkedin / internal / condition nodes are authored here and persisted
// in `campaigns.flow_graph`, but do NOT run until the branch-execution phase
// ships. To keep the current sender working, `graphToSteps` derives the linear
// `campaign_steps` the dispatcher walks from the graph's PRIMARY PATH (follow
// every condition's `no` branch), accumulating wait days across skipped
// (linkedin/internal) nodes so an email's cadence is preserved.

export type FlowConditionTrigger =
  // Inbound signals we route on — no outbound tracking required.
  | "replied" // any inbound reply, regardless of class
  | "reply_interested" // reply classified interested/positive (the hot classes)
  | "reply_objection" // reply classified as an objection (price / timing)
  | "reply_not_interested" // not interested / wrong person / unsubscribe
  | "reply_ooo" // out-of-office auto-reply
  | "bounced"
  // Legacy triggers kept ONLY so stored graphs still type-check + load. They are
  // NOT offered in the builder and evaluate to the NO branch at runtime: opened/
  // clicked need open/link tracking we deliberately never add (deliverability),
  // and `manual` has no automation. See src/lib/flow/runtime.ts.
  | "opened"
  | "clicked"
  | "manual";

export type FlowInternalAction = "notify" | "task" | "webhook";

export type FlowLinkedInKind = "connect_request" | "message";

export interface FlowNodeBase {
  id: string;
}

export interface EmailNode extends FlowNodeBase {
  kind: "email";
  subject: string; // may be "" on follow-ups — they thread as "Re:"
  body: string;
}

export interface WaitNode extends FlowNodeBase {
  kind: "wait";
  wait_days: number;
}

export interface LinkedInNode extends FlowNodeBase {
  kind: "linkedin";
  li_kind: FlowLinkedInKind;
  body: string;
}

export interface InternalNode extends FlowNodeBase {
  kind: "internal";
  action: FlowInternalAction;
  label: string;
  target?: string; // e.g. a teammate / channel — free text for now
}

export interface ConditionNode extends FlowNodeBase {
  kind: "condition";
  trigger: FlowConditionTrigger;
  yes: FlowNode[];
  no: FlowNode[];
}

export type FlowNode =
  | EmailNode
  | WaitNode
  | LinkedInNode
  | InternalNode
  | ConditionNode;

export interface FlowGraph {
  version: 1;
  nodes: FlowNode[];
}

/** A step as the create / update-sequence APIs expect it. */
export interface DerivedStep {
  wait_days: number;
  subject_template: string | null;
  body_template: string;
}

/** A step as it comes back from the DB (campaign_steps rows). */
export interface StepRow {
  wait_days: number;
  subject_template: string | null;
  body_template: string | null;
}

// ---- ids + factories ---------------------------------------------------

let _counter = 0;
export function newId(): string {
  const c =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as Crypto | undefined)
      : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  _counter += 1;
  return `n_${_counter}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emailNode(subject = "", body = "", id = newId()): EmailNode {
  return { id, kind: "email", subject, body };
}
export function waitNode(wait_days = 3, id = newId()): WaitNode {
  return { id, kind: "wait", wait_days };
}
export function linkedinNode(
  li_kind: FlowLinkedInKind = "connect_request",
  body = "",
  id = newId(),
): LinkedInNode {
  return { id, kind: "linkedin", li_kind, body };
}
export function internalNode(
  action: FlowInternalAction = "notify",
  label = "",
  id = newId(),
): InternalNode {
  return { id, kind: "internal", action, label };
}
export function conditionNode(
  trigger: FlowConditionTrigger = "replied",
  yes: FlowNode[] = [],
  no: FlowNode[] = [],
  id = newId(),
): ConditionNode {
  return { id, kind: "condition", trigger, yes, no };
}

export function emptyGraph(): FlowGraph {
  return { version: 1, nodes: [] };
}

/**
 * The starter template a new native campaign opens with: a first email, then a
 * "did they reply?" fork (yes → notify the account manager; no → two follow-ups).
 * Shows the branching flow on load; the executed path is the three emails down
 * the `no` branch. Reply-based only — we don't track opens/clicks, so the fork
 * routes on the one inbound signal we actually have.
 */
export function starterGraph(): FlowGraph {
  const first = emailNode(
    "Quick question, {{first_name}}",
    "Hi {{first_name}},\n\n{{intro_line}}\n\nDoes {{company}} still handle this by hand? We help teams like yours get more done without adding headcount.\n\nWorth a quick look?\n\n— [Your name]",
  );
  const followUp = emailNode(
    "",
    "Just following up, {{first_name}} — worth a quick 15-minute chat to see if there's a fit?",
  );
  const breakup = emailNode(
    "",
    "Closing the loop here. If the timing's off, no worries — reach out anytime.",
  );
  const replied = conditionNode(
    "replied",
    [internalNode("notify", "Notify the account manager")],
    [waitNode(3), followUp, waitNode(2), breakup],
  );
  return { version: 1, nodes: [first, replied] };
}

// ---- traversal ---------------------------------------------------------

/**
 * The primary (executed) path: a flat list with every condition replaced by
 * its `no` branch, recursively. Condition nodes themselves are dropped — they
 * are control flow, not steps.
 */
export function flattenPrimaryPath(nodes: FlowNode[]): FlowNode[] {
  const out: FlowNode[] = [];
  for (const n of nodes) {
    if (n.kind === "condition") out.push(...flattenPrimaryPath(n.no));
    else out.push(n);
  }
  return out;
}

/** Depth-first visit of every node in the tree (both branches). */
export function walkAll(nodes: FlowNode[], fn: (n: FlowNode) => void): void {
  for (const n of nodes) {
    fn(n);
    if (n.kind === "condition") {
      walkAll(n.yes, fn);
      walkAll(n.no, fn);
    }
  }
}

export function countEmails(graph: FlowGraph): number {
  let n = 0;
  walkAll(graph.nodes, (node) => {
    if (node.kind === "email") n += 1;
  });
  return n;
}

// ---- steps <-> graph ---------------------------------------------------

/**
 * Build a linear graph from stored campaign_steps (email nodes, with a wait
 * node inserted before any step that waits). This is what we render when a
 * campaign has no stored flow_graph yet (pre-migration, or legacy campaigns).
 */
export function stepsToGraph(steps: StepRow[]): FlowGraph {
  const nodes: FlowNode[] = [];
  for (const s of steps) {
    const wait = Number(s.wait_days) || 0;
    if (wait > 0) nodes.push(waitNode(wait));
    nodes.push(emailNode(s.subject_template ?? "", s.body_template ?? ""));
  }
  return { version: 1, nodes };
}

/**
 * Derive the linear email steps the native sender executes from a flow graph.
 * Walks the primary path; wait days accumulate across non-email nodes so the
 * cadence to the next email is preserved even when a skipped linkedin/internal
 * node sits between the wait and the email.
 */
export function graphToSteps(graph: FlowGraph): DerivedStep[] {
  const steps: DerivedStep[] = [];
  let pendingWait = 0;
  for (const n of flattenPrimaryPath(graph.nodes)) {
    if (n.kind === "wait") {
      pendingWait += Number(n.wait_days) || 0;
    } else if (n.kind === "email") {
      steps.push({
        wait_days: pendingWait,
        subject_template: n.subject.trim() ? n.subject.trim() : null,
        body_template: n.body,
      });
      pendingWait = 0;
    }
    // linkedin / internal: not executed yet — leave pendingWait intact so it
    // applies to the next email on the path.
  }
  return steps;
}

// ---- validation --------------------------------------------------------

/**
 * Validate the executable path against the same rules the APIs enforce, plus a
 * light check that every authored email (in any branch) has a body. Returns an
 * error string, or null when the graph is savable.
 */
export function validateGraph(graph: FlowGraph): string | null {
  const steps = graphToSteps(graph);
  if (steps.length === 0) return "Add at least one email step.";
  if (!steps[0].subject_template) return "The first email needs a subject line.";
  for (let i = 0; i < steps.length; i++) {
    if (!steps[i].body_template.trim()) return `Email ${i + 1} needs a body.`;
  }
  let branchError: string | null = null;
  walkAll(graph.nodes, (n) => {
    if (branchError) return;
    if (n.kind === "email" && !n.body.trim()) {
      branchError = "Every email in the flow needs a body.";
    }
  });
  return branchError;
}
