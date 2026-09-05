// A/B auto-winner: the significance test that pauses losing variants once a
// test has gathered enough data, plus the pure graph mutations that persist and
// preserve those pauses.
//
// Everything here is PURE (no IO): the evaluator (cron/sync-analytics) fetches
// the sends + replies, computes stats (variants.ts), then calls decideAbWinner
// per node and mergePausedIntoGraph to produce the graph to store. The
// update-sequence save route calls mergeStoredPauses to keep an auto-decision
// alive across a manual builder edit.
//
// Measured on POSITIVE-REPLY RATE only: we never track opens/clicks
// (deliverability), so that inbound signal is the sole yardstick.

import {
  emailVariants,
  walkAll,
  type FlowGraph,
  type FlowNode,
  type EmailNode,
} from "./graph";
import type { AbNodeStats, VariantStat } from "./variants";

export interface AbWinnerConfig {
  /** MUST be true for the auto-winner to pause anything on this node (opt-in). */
  autoPause: boolean;
  /** Both sides of a leader-vs-challenger comparison need ≥ this many sends. */
  minSentPerVariant: number;
  /** The node needs ≥ this many sends across active variants before deciding. */
  minTotalSent: number;
  /** The leader needs ≥ this many positive replies (don't crown on a lucky one). */
  minPositives: number;
  /** The leader must lead a challenger's positive-reply rate by ≥ this many points. */
  minAbsoluteLeadPct: number;
  /** Family-wise one-sided confidence; Bonferroni-split across live challengers. */
  confidence: number;
}

// OFF by default (autoPause:false), and conservative once on. Positive-reply
// rates are low, so a verdict needs real volume AND a real gap before it fires,
// never call a winner on noise. Tunable per node via EmailNode.ab_config.
export const DEFAULT_AB_WINNER_CONFIG: AbWinnerConfig = {
  autoPause: false,
  minSentPerVariant: 30,
  minTotalSent: 60,
  minPositives: 3,
  minAbsoluteLeadPct: 1,
  confidence: 0.95,
};

/**
 * Resolve a node's effective config. autoPause cascades node override → campaign
 * default → false; thresholds cascade node override → system default. So a node
 * with no ab_config inherits the campaign's `ab_auto_pause_default`, and a node
 * that sets ab_config.autoPause (true OR false) overrides that campaign default.
 */
export function resolveAbConfig(node: EmailNode, campaignDefault?: boolean): AbWinnerConfig {
  const o = node.ab_config;
  const d = DEFAULT_AB_WINNER_CONFIG;
  return {
    autoPause: o?.autoPause ?? campaignDefault ?? d.autoPause,
    minSentPerVariant: o?.minSentPerVariant ?? d.minSentPerVariant,
    minTotalSent: o?.minTotalSent ?? d.minTotalSent,
    minPositives: o?.minPositives ?? d.minPositives,
    minAbsoluteLeadPct: o?.minAbsoluteLeadPct ?? d.minAbsoluteLeadPct,
    confidence: o?.confidence ?? d.confidence,
  };
}

export interface AbDecision {
  nodeId: string;
  /** Best active variant (the one we keep). Null when there isn't enough data. */
  leaderId: string | null;
  /** Variant ids to newly PAUSE (losers). Empty when there's no verdict yet. */
  pauseIds: string[];
  /** True when, after these pauses, exactly one active variant remains. */
  decided: boolean;
  reason: string;
}

// ── inverse-normal (probit) ──────────────────────────────────────────────────
// Acklam's rational approximation of the inverse standard-normal CDF, accurate
// to ~1.15e-9 over p ∈ (0,1). Pure. Used to turn a confidence level into a
// critical z (probit(0.95) ≈ 1.6449, probit(0.975) ≈ 1.9600).
function invNormCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Critical z for a one-sided test at the given confidence (clamped to a sane band). */
export function zCritOneSided(confidence: number): number {
  const c = Math.min(0.9999, Math.max(0.5, confidence));
  return invNormCdf(c);
}

// Two-proportion one-sided z-test: is `lead`'s positive-reply proportion
// significantly higher than `chal`'s at the critical z? Uses raw positive/sent
// counts (not the rounded pct). A degenerate pooled SE (no positives in either)
// → not significant, so we never pause on zero evidence.
function leaderBeats(lead: VariantStat, chal: VariantStat, zCrit: number): boolean {
  const n1 = lead.sent;
  const n2 = chal.sent;
  if (n1 <= 0 || n2 <= 0) return false;
  const p1 = lead.positive / n1;
  const p2 = chal.positive / n2;
  if (p1 <= p2) return false;
  const pPool = (lead.positive + chal.positive) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return false;
  return (p1 - p2) / se >= zCrit;
}

/**
 * Decide which of an A/B node's ACTIVE variants to pause. Pure: takes the
 * already-computed per-variant stats and a threshold config, returns the losers
 * to pause (never the leader, never below the min-sends floors). Monotonic: it
 * only ever proposes NEW pauses among currently-active variants; the caller
 * unions them into the graph, so a decision, once made, sticks.
 */
export function decideAbWinner(
  node: AbNodeStats,
  config: AbWinnerConfig = DEFAULT_AB_WINNER_CONFIG,
): AbDecision {
  // Opt-in: the auto-winner never touches a node unless it's explicitly enabled.
  if (!config.autoPause) {
    return {
      nodeId: node.nodeId,
      leaderId: null,
      pauseIds: [],
      decided: false,
      reason: "auto-pause disabled for this node",
    };
  }

  const active = node.variants.filter((v) => !v.paused);

  // 0 or 1 active variant → nothing left to test. It's "decided" iff a survivor
  // stands alone after a prior pause.
  if (active.length <= 1) {
    return {
      nodeId: node.nodeId,
      leaderId: active[0]?.id ?? null,
      pauseIds: [],
      decided: active.length === 1 && node.variants.some((v) => v.paused),
      reason: "single active variant, nothing left to test",
    };
  }

  const totalSent = active.reduce((s, v) => s + v.sent, 0);
  if (totalSent < config.minTotalSent) {
    return {
      nodeId: node.nodeId,
      leaderId: null,
      pauseIds: [],
      decided: false,
      reason: `gathering data (${totalSent}/${config.minTotalSent} sends)`,
    };
  }

  // Leader = highest positive-reply rate among active with data; tie-break by
  // more sends (more trustworthy), then id for determinism.
  const ranked = [...active].sort(
    (a, b) => b.positiveRatePct - a.positiveRatePct || b.sent - a.sent || (a.id < b.id ? -1 : 1),
  );
  const leader = ranked[0];
  // Evidence gate: the leader needs real volume AND enough positives, never
  // crown on a thin sample or one lucky reply.
  if (leader.sent < config.minSentPerVariant || leader.positive < config.minPositives) {
    return {
      nodeId: node.nodeId,
      leaderId: leader.id,
      pauseIds: [],
      decided: false,
      reason: `leader needs more evidence (${leader.sent} sent / ${leader.positive} positive; need ${config.minSentPerVariant}/${config.minPositives})`,
    };
  }

  // Only challengers with enough sends are compared; a still-thin rival keeps the
  // test open (never paused, never a premature winner).
  const challengers = active.filter(
    (v) => v.id !== leader.id && v.sent >= config.minSentPerVariant,
  );
  // Bonferroni: hold the family-wise error to (1 - confidence) across the
  // comparisons we make this pass, so 3+ variants demand a higher per-test bar.
  const k = Math.max(1, challengers.length);
  const zCrit = zCritOneSided(1 - (1 - config.confidence) / k);
  const leaderRate = leader.positive / leader.sent;

  const pauseIds: string[] = [];
  for (const chal of challengers) {
    const leadPts = (leaderRate - chal.positive / chal.sent) * 100;
    if (leadPts < config.minAbsoluteLeadPct) continue; // significant but not a MEANINGFUL lead
    if (leaderBeats(leader, chal, zCrit)) pauseIds.push(chal.id); // significant at the corrected level
  }

  const remainingActive = active.length - pauseIds.length;
  return {
    nodeId: node.nodeId,
    leaderId: leader.id,
    pauseIds,
    decided: pauseIds.length > 0 && remainingActive === 1,
    reason:
      pauseIds.length === 0
        ? `${leader.label} leads but hasn't decisively beaten every rival yet`
        : `${leader.label} wins: ≥${config.minAbsoluteLeadPct}pt lead + ${Math.round(config.confidence * 100)}% significance (Bonferroni k=${k}); pausing ${pauseIds.length}`,
  };
}

// ── graph merges (pure) ──────────────────────────────────────────────────────

/**
 * Union auto-winner pause plans into a graph. For each plan, adds its pauseIds
 * to the matching email node's paused_variant_ids: deduped, and only ids that
 * are real variants of that node. Returns a NEW graph and whether anything
 * changed; the evaluator persists only when `changed` (so a steady state writes
 * nothing).
 */
export function mergePausedIntoGraph(
  graph: FlowGraph,
  plans: { nodeId: string; pauseIds: string[] }[],
): { graph: FlowGraph; changed: boolean } {
  const byNode = new Map<string, Set<string>>();
  for (const p of plans) {
    if (!p.pauseIds.length) continue;
    let s = byNode.get(p.nodeId);
    if (!s) {
      s = new Set();
      byNode.set(p.nodeId, s);
    }
    for (const id of p.pauseIds) s.add(id);
  }
  if (byNode.size === 0) return { graph, changed: false };

  let changed = false;
  const apply = (nodes: FlowNode[]): FlowNode[] =>
    nodes.map((n) => {
      if (n.kind === "condition") return { ...n, yes: apply(n.yes), no: apply(n.no) };
      if (n.kind !== "email") return n;
      const add = byNode.get(n.id);
      if (!add || add.size === 0) return n;
      const validIds = new Set(emailVariants(n).map((v) => v.id));
      const current = new Set(n.paused_variant_ids ?? []);
      let grew = false;
      for (const id of add) {
        if (validIds.has(id) && !current.has(id)) {
          current.add(id);
          grew = true;
        }
      }
      if (!grew) return n;
      changed = true;
      return { ...n, paused_variant_ids: [...current] };
    });

  const next: FlowGraph = { ...graph, nodes: apply(graph.nodes) };
  return { graph: changed ? next : graph, changed };
}

/**
 * Re-apply the auto-winner's STORED pauses onto an INCOMING graph (a manual
 * builder save). paused_variant_ids is server-owned: the builder never authors
 * it, so a save must not clear it. For every email node the stored graph has
 * pauses on, set the incoming node's paused_variant_ids to the stored ids that
 * still exist in the incoming node (a deleted variant drops its pause).
 */
export function mergeStoredPauses(incoming: FlowGraph, stored: FlowGraph | null): FlowGraph {
  if (!stored) return incoming;
  const storedByNode = new Map<string, string[]>();
  walkAll(stored.nodes, (n) => {
    if (n.kind === "email" && n.paused_variant_ids?.length) {
      storedByNode.set(n.id, n.paused_variant_ids);
    }
  });
  if (storedByNode.size === 0) return incoming;

  const apply = (nodes: FlowNode[]): FlowNode[] =>
    nodes.map((n) => {
      if (n.kind === "condition") return { ...n, yes: apply(n.yes), no: apply(n.no) };
      if (n.kind !== "email") return n;
      const storedIds = storedByNode.get(n.id);
      if (!storedIds) return n;
      const validIds = new Set(emailVariants(n).map((v) => v.id));
      const keep = storedIds.filter((id) => validIds.has(id));
      return { ...n, paused_variant_ids: keep };
    });

  return { ...incoming, nodes: apply(incoming.nodes) };
}
