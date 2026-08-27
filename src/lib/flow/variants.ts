// Email A/B (and C/D…) testing — assignment + measurement.
//
// A flow email node can carry extra `variants`. The sender assigns each
// enrollment a variant DETERMINISTICALLY from (contactId, nodeId) — a stable,
// even split with no stored state (sticky across re-sends) — and stamps
// native_sends.variant_id. Measurement joins those sends to lead_replies for a
// per-variant reply / positive-reply rate. Pure: no IO.

import {
  emailVariants,
  activeVariants,
  isAbTest,
  walkAll,
  flattenPrimaryPath,
  type FlowGraph,
  type EmailNode,
  type ResolvedVariant,
} from "./graph";
import { replyClassGroup } from "./runtime";
import type { ReplyClass } from "@/types/app";

// FNV-1a 32-bit — a tiny deterministic string hash for an even, stable split.
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministically (stickily) assign a contact to one of an email node's
 * variants. Same (contact, node) → same variant every time, so re-sends and
 * analytics agree without storing the assignment. Single-variant node → variant A.
 *
 * Auto-winner interaction:
 *  - NEW assignments split only across ACTIVE (non-paused) variants, so once a
 *    loser is paused fresh leads route to the leader. The hash is taken over the
 *    active pool, so pausing a variant re-balances new leads across the rest.
 *  - `opts.assignedId` makes it STICKY: when a contact was already assigned a
 *    variant for this node (recorded in native_sends.variant_id) we return that
 *    exact variant — even if it is now paused — so a lead's thread never
 *    re-routes mid-flight (e.g. a follow-up's "Re:" subject stays on the variant
 *    they actually received). An unknown/stale assignedId falls through to a
 *    fresh active-pool pick.
 */
export function pickVariant(
  node: EmailNode,
  contactId: string,
  opts?: { assignedId?: string | null },
): ResolvedVariant {
  if (opts?.assignedId) {
    const already = emailVariants(node).find((v) => v.id === opts.assignedId);
    if (already) return already; // sticky — honor the recorded assignment, paused or not
  }
  const pool = activeVariants(node);
  if (pool.length <= 1) return pool[0];
  return pool[hashStr(`${contactId}:${node.id}`) % pool.length];
}

export interface VariantStat {
  id: string;
  label: string;
  subject: string;
  sent: number;
  replied: number;
  positive: number;
  replyRatePct: number;
  positiveRatePct: number;
  /** Auto-winner has paused this variant (a loser on positive-reply rate). */
  paused: boolean;
}

export interface AbNodeStats {
  nodeId: string;
  firstEmail: boolean;
  variants: VariantStat[];
  /**
   * Current front-runner among the ACTIVE (non-paused) variants: highest
   * positive-reply rate with ≥1 send and ≥1 positive; else null. Not
   * necessarily final — see `winnerId` for a locked auto-winner.
   */
  leaderId: string | null;
  /**
   * The locked auto-winner: set only once the test is DECIDED — exactly one
   * active variant remains and ≥1 other was auto-paused. Null while the test is
   * still gathering data or has no pauses yet.
   */
  winnerId: string | null;
  /** Auto-winner reached a verdict (winnerId is set). */
  decided: boolean;
  /** This node opted into auto-pause (EmailNode.ab_config.autoPause). Display hint. */
  autoPause: boolean;
}

/**
 * Per-A/B-node variant tallies, from native_sends.variant_id + lead_replies.
 * `campaignAutoPauseDefault` (campaigns.ab_auto_pause_default) is the fallback a
 * node inherits when it hasn't overridden auto-pause — used only to set each
 * node's display `autoPause` (the effective on/off shown in the results table).
 */
export function computeVariantStats(
  graph: FlowGraph,
  sends: { variant_id: string | null; to_email: string | null }[],
  replyByEmail: Map<string, ReplyClass | null>,
  campaignAutoPauseDefault?: boolean,
): AbNodeStats[] {
  const abNodes: { node: EmailNode; variants: ResolvedVariant[] }[] = [];
  walkAll(graph.nodes, (n) => {
    if (n.kind === "email" && isAbTest(n)) abNodes.push({ node: n, variants: emailVariants(n) });
  });
  if (abNodes.length === 0) return [];

  const firstEmailId =
    flattenPrimaryPath(graph.nodes).find((n) => n.kind === "email")?.id ?? null;
  const known = new Set<string>();
  for (const { variants } of abNodes) for (const v of variants) known.add(v.id);

  const tally = new Map<string, { sent: number; replied: number; positive: number }>();
  for (const s of sends) {
    if (!s.variant_id || !known.has(s.variant_id)) continue;
    let t = tally.get(s.variant_id);
    if (!t) {
      t = { sent: 0, replied: 0, positive: 0 };
      tally.set(s.variant_id, t);
    }
    t.sent += 1;
    const email = s.to_email?.trim().toLowerCase();
    if (email && replyByEmail.has(email)) {
      t.replied += 1;
      if (replyClassGroup(replyByEmail.get(email) ?? null) === "interested") t.positive += 1;
    }
  }

  return abNodes.map(({ node, variants }) => {
    const stats: VariantStat[] = variants.map((v) => {
      const t = tally.get(v.id) ?? { sent: 0, replied: 0, positive: 0 };
      const denom = t.sent || 1;
      return {
        id: v.id,
        label: v.label,
        subject: v.subject,
        sent: t.sent,
        replied: t.replied,
        positive: t.positive,
        replyRatePct: Math.round((t.replied / denom) * 1000) / 10,
        positiveRatePct: Math.round((t.positive / denom) * 1000) / 10,
        paused: v.paused,
      };
    });
    // Leader = best positive-reply rate among the ACTIVE (non-paused) variants —
    // the front-runner a paused-out test has settled on, or the current best
    // while a test is still running.
    let leaderId: string | null = null;
    let best = -1;
    for (const st of stats) {
      if (!st.paused && st.sent > 0 && st.positive > 0 && st.positiveRatePct > best) {
        best = st.positiveRatePct;
        leaderId = st.id;
      }
    }
    // Winner is locked only when the auto-winner has paused ≥1 variant AND a
    // single active variant remains (an unambiguous survivor).
    const active = stats.filter((s) => !s.paused);
    const pausedAny = stats.some((s) => s.paused);
    const winnerId = pausedAny && active.length === 1 ? active[0].id : null;
    return {
      nodeId: node.id,
      firstEmail: node.id === firstEmailId,
      variants: stats,
      leaderId,
      winnerId,
      decided: winnerId !== null,
      autoPause: node.ab_config?.autoPause ?? campaignAutoPauseDefault ?? false,
    };
  });
}
