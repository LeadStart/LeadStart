#!/usr/bin/env node
/**
 * Unit tests for A/B variant assignment + measurement (src/lib/flow/variants.ts,
 * plus emailVariants/isAbTest in graph.ts). Pure. Run:
 *   npx tsx scripts/test-flow-variants.ts
 */
import {
  emailNode,
  emailVariant,
  emailVariants,
  isAbTest,
  type FlowGraph,
} from "../src/lib/flow/graph.ts";
import { pickVariant, computeVariantStats } from "../src/lib/flow/variants.ts";
import type { ReplyClass } from "../src/types/app.ts";

let pass = 0;
let fail = 0;
function eq<T>(got: T, want: T, msg: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg} (got ${g}, want ${w})`);
  }
}
function ok(cond: boolean, msg: string) {
  eq(cond, true, msg);
}

// ── emailVariants + isAbTest ─────────────────────────────────────────────────
console.log("emailVariants + isAbTest");
{
  const plain = emailNode("S", "B", "e1");
  eq(isAbTest(plain), false, "no extra variants → not an A/B test");
  eq(emailVariants(plain).map((v) => v.label), ["A"], "single node → [A]");
  eq(emailVariants(plain)[0].id, "e1", "variant A id = node id");

  const ab = emailNode("Sa", "Ba", "e1");
  ab.variants = [emailVariant("Sb", "Bb", "vb"), emailVariant("Sc", "Bc", "vc")];
  eq(isAbTest(ab), true, "extras present → A/B test");
  eq(
    emailVariants(ab).map((v) => [v.label, v.id, v.subject]),
    [
      ["A", "e1", "Sa"],
      ["B", "vb", "Sb"],
      ["C", "vc", "Sc"],
    ],
    "A/B/C labels + ids + subjects",
  );
}

// ── pickVariant: deterministic, sticky, even ─────────────────────────────────
console.log("pickVariant — deterministic + even split");
{
  const ab = emailNode("Sa", "Ba", "e1");
  ab.variants = [emailVariant("Sb", "Bb", "vb")]; // 2 variants: A, B
  const plain = emailNode("S", "B", "single");

  eq(pickVariant(plain, "c1").id, "single", "single-variant node → variant A always");
  eq(pickVariant(ab, "c1").id, pickVariant(ab, "c1").id, "same (contact,node) → same variant (sticky)");

  // Even-ish split over many contacts.
  const counts: Record<string, number> = { e1: 0, vb: 0 };
  for (let i = 0; i < 2000; i++) counts[pickVariant(ab, `contact_${i}`).id] += 1;
  ok(counts.e1 > 700 && counts.e1 < 1300, `variant A got a fair share (${counts.e1}/2000)`);
  ok(counts.vb > 700 && counts.vb < 1300, `variant B got a fair share (${counts.vb}/2000)`);
  eq(counts.e1 + counts.vb, 2000, "every contact assigned exactly one variant");

  // Different node id → independent assignment (not all the same contact→variant).
  const ab2 = emailNode("x", "y", "e2");
  ab2.variants = [emailVariant("x2", "y2", "vb2")];
  let differ = 0;
  for (let i = 0; i < 50; i++) {
    const a = pickVariant(ab, `k${i}`).label;
    const b = pickVariant(ab2, `k${i}`).label;
    if (a !== b) differ += 1;
  }
  ok(differ > 5, `assignment varies by node, not just contact (${differ}/50 differ)`);
}

// ── computeVariantStats ──────────────────────────────────────────────────────
console.log("computeVariantStats");
{
  const e1 = emailNode("Subject A", "Body A", "e1");
  e1.variants = [emailVariant("Subject B", "Body B", "vb"), emailVariant("Subject C", "Body C", "vc")];
  const graph: FlowGraph = { version: 1, nodes: [e1] };

  const replies = new Map<string, ReplyClass | null>([
    ["a1@x.com", "true_interest"], // A: positive
    ["a2@x.com", "objection_price"], // A: replied, not positive
    ["c1@x.com", "true_interest"], // C: positive
    ["c2@x.com", "meeting_booked"], // C: positive
  ]);
  const sends = [
    { variant_id: "e1", to_email: "a1@x.com" },
    { variant_id: "e1", to_email: "a2@x.com" },
    { variant_id: "e1", to_email: "a3@x.com" }, // no reply
    { variant_id: "vb", to_email: "b1@x.com" }, // no reply
    { variant_id: "vb", to_email: "b2@x.com" }, // no reply
    { variant_id: "vc", to_email: "c1@x.com" },
    { variant_id: "vc", to_email: "c2@x.com" },
    { variant_id: "unknown_node", to_email: "z@x.com" }, // ignored (not a known variant)
    { variant_id: null, to_email: "n@x.com" }, // ignored (non-A/B send)
  ];

  const stats = computeVariantStats(graph, sends, replies);
  eq(stats.length, 1, "one A/B node");
  const node = stats[0];
  eq(node.nodeId, "e1", "node id");
  eq(node.firstEmail, true, "e1 is the first email");
  eq(
    node.variants.map((v) => [v.label, v.sent, v.replied, v.positive]),
    [
      ["A", 3, 2, 1],
      ["B", 2, 0, 0],
      ["C", 2, 2, 2],
    ],
    "per-variant sent / replied / positive",
  );
  eq(node.variants[0].positiveRatePct, 33.3, "A positive rate = 1/3 = 33.3%");
  eq(node.variants[2].positiveRatePct, 100, "C positive rate = 2/2 = 100%");
  eq(node.leaderId, "vc", "leader = C (highest positive rate with ≥1 positive)");
}

console.log("computeVariantStats — no A/B nodes → empty");
{
  const graph: FlowGraph = { version: 1, nodes: [emailNode("S", "B", "e1")] };
  eq(computeVariantStats(graph, [{ variant_id: "e1", to_email: "x@x.com" }], new Map()).length, 0, "no A/B nodes → []");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
