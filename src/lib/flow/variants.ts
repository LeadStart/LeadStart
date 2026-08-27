// Email A/B (and C/D…) testing — assignment + measurement.
//
// A flow email node can carry extra `variants`. The sender assigns each
// enrollment a variant DETERMINISTICALLY from (contactId, nodeId) — a stable,
// even split with no stored state (sticky across re-sends) — and stamps
// native_sends.variant_id. Measurement joins those sends to lead_replies for a
// per-variant reply / positive-reply rate. Pure: no IO.

import {
  emailVariants,
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
 */
export function pickVariant(node: EmailNode, contactId: string): ResolvedVariant {
  const vs = emailVariants(node);
  if (vs.length <= 1) return vs[0];
  return vs[hashStr(`${contactId}:${node.id}`) % vs.length];
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
}

export interface AbNodeStats {
  nodeId: string;
  firstEmail: boolean;
  variants: VariantStat[];
  /** Highest positive-reply-rate variant with ≥1 send and ≥1 positive; else null. */
  leaderId: string | null;
}

/** Per-A/B-node variant tallies, from native_sends.variant_id + lead_replies. */
export function computeVariantStats(
  graph: FlowGraph,
  sends: { variant_id: string | null; to_email: string | null }[],
  replyByEmail: Map<string, ReplyClass | null>,
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
      };
    });
    let leaderId: string | null = null;
    let best = -1;
    for (const st of stats) {
      if (st.sent > 0 && st.positive > 0 && st.positiveRatePct > best) {
        best = st.positiveRatePct;
        leaderId = st.id;
      }
    }
    return { nodeId: node.id, firstEmail: node.id === firstEmailId, variants: stats, leaderId };
  });
}
