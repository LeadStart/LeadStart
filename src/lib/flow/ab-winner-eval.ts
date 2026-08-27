// A/B auto-winner evaluation for one campaign — the IO wrapper around the pure
// decision in ab-winner.ts. Called by the hourly analytics cron (sync-analytics)
// — NEVER the send hot-path — and exercised directly by the e2e. It takes the
// send log + reply rows the caller already paged, runs the significance test per
// A/B node, and merge-safely persists any new pauses into campaigns.flow_graph.

import type { SupabaseClient } from "@supabase/supabase-js";
import { walkAll, isAbTest, type FlowGraph, type EmailNode } from "./graph";
import { computeVariantStats } from "./variants";
import { decideAbWinner, resolveAbConfig, mergePausedIntoGraph } from "./ab-winner";
import type { ReplyClass } from "@/types/app";

/** Count paused variant ids across every email node in a graph. */
export function countPausedVariants(graph: FlowGraph): number {
  let n = 0;
  walkAll(graph.nodes, (node) => {
    if (node.kind === "email") n += node.paused_variant_ids?.length ?? 0;
  });
  return n;
}

/**
 * Run the A/B auto-winner for one campaign. Uses the SAME send log + reply
 * numbers the Analytics tab shows to pause losing variants once a node has
 * gathered enough sends, so new leads route to the leader. Pure decision
 * (decideAbWinner) + a merge-safe write: re-reads the current flow_graph, unions
 * the new pauses in, and persists only if something changed — an already-decided
 * test writes nothing. Touches only flow_graph (a pause is a runtime event, not
 * a content edit). Returns the number of variants newly paused.
 */
export async function evaluateAbWinners(
  admin: SupabaseClient,
  campaignId: string,
  graph: FlowGraph,
  sends: { variant_id: string | null; to_email: string | null }[],
  replies: { final_class: string | null; lead_email: string | null }[],
  campaignAutoPauseDefault = false,
): Promise<number> {
  // Skip cheaply unless the graph actually tests a variant.
  let hasAb = false;
  const nodeById = new Map<string, EmailNode>();
  walkAll(graph.nodes, (n) => {
    if (n.kind === "email") {
      nodeById.set(n.id, n);
      if (isAbTest(n)) hasAb = true;
    }
  });
  if (!hasAb) return 0;

  // Latest reply class per lead email (rows arrive oldest-first, so a later row
  // overwrites an earlier → newest wins). The "interested" grouping that counts
  // as a positive lives in computeVariantStats — the same one the A/B table uses.
  const replyByEmail = new Map<string, ReplyClass | null>();
  for (const r of replies) {
    const em = r.lead_email?.trim().toLowerCase();
    if (em) replyByEmail.set(em, (r.final_class as ReplyClass | null) ?? null);
  }

  const stats = computeVariantStats(graph, sends, replyByEmail);
  const plans: { nodeId: string; pauseIds: string[] }[] = [];
  for (const node of stats) {
    const def = nodeById.get(node.nodeId);
    const decision = decideAbWinner(
      node,
      def ? resolveAbConfig(def, campaignAutoPauseDefault) : undefined,
    );
    if (decision.pauseIds.length) plans.push({ nodeId: node.nodeId, pauseIds: decision.pauseIds });
  }
  if (plans.length === 0) return 0;

  // Merge-safe write: re-read the freshest graph so a concurrent builder save
  // isn't clobbered, union the pauses in, persist only when it grew.
  const { data: fresh } = await admin
    .from("campaigns")
    .select("flow_graph")
    .eq("id", campaignId)
    .maybeSingle();
  const freshGraph = (fresh as { flow_graph: FlowGraph | null } | null)?.flow_graph ?? null;
  if (!freshGraph) return 0;
  const { graph: merged, changed } = mergePausedIntoGraph(freshGraph, plans);
  if (!changed) return 0;
  const { error } = await admin.from("campaigns").update({ flow_graph: merged }).eq("id", campaignId);
  if (error) throw error;
  return countPausedVariants(merged) - countPausedVariants(freshGraph);
}
