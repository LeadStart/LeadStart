#!/usr/bin/env node
/**
 * Render smoke test for AbResults (the A/B table on the campaign Analytics tab).
 * Renders the component to static HTML with representative stats and asserts the
 * right labels appear for each state — a decided test (Winner + Paused), a
 * running test (Leading, no Winner), and the reply/positive numbers. Proves the
 * display logic + data contract without a browser. Run:
 *   npx tsx scripts/test-ab-results-render.ts
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AbResults } from "../src/components/campaigns/flow/ab-results.tsx";
import type { AbNodeStats, VariantStat } from "../src/lib/flow/variants.ts";

let pass = 0;
let fail = 0;
function has(html: string, needle: string, msg: string) {
  if (html.includes(needle)) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg} (missing: ${needle})`);
  }
}
function absent(html: string, needle: string, msg: string) {
  if (!html.includes(needle)) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg} (unexpectedly present: ${needle})`);
  }
}

function v(id: string, label: string, subject: string, sent: number, replied: number, positive: number, paused: boolean): VariantStat {
  const denom = sent || 1;
  return {
    id, label, subject, sent, replied, positive,
    replyRatePct: Math.round((replied / denom) * 1000) / 10,
    positiveRatePct: Math.round((positive / denom) * 1000) / 10,
    paused,
  };
}

// A decided node: A won, B auto-paused.
const decided: AbNodeStats = {
  nodeId: "E1",
  firstEmail: true,
  variants: [
    v("E1", "A", "Quick question", 80, 20, 12, false),
    v("VB", "B", "Got a minute", 80, 8, 2, true),
  ],
  leaderId: "E1",
  winnerId: "E1",
  decided: true,
  autoPause: true,
};

// A running node with auto-pause ON: A leads, nothing paused yet.
const running: AbNodeStats = {
  nodeId: "E2",
  firstEmail: false,
  variants: [
    v("E2", "A", "", 20, 4, 2, false),
    v("VC", "B", "", 20, 3, 1, false),
  ],
  leaderId: "E2",
  winnerId: null,
  decided: false,
  autoPause: true,
};

// A running node with auto-pause OFF (manual).
const manual: AbNodeStats = {
  nodeId: "E3",
  firstEmail: true,
  variants: [
    v("E3", "A", "Hello there", 40, 10, 6, false),
    v("VD", "B", "Hi there", 40, 9, 5, false),
  ],
  leaderId: "E3",
  winnerId: null,
  decided: false,
  autoPause: false,
};

console.log("AbResults — decided test renders Winner + Paused");
{
  const html = renderToStaticMarkup(createElement(AbResults, { stats: [decided] }));
  has(html, "Winner", "shows the Winner badge");
  has(html, "Paused", "shows the Paused badge on the loser");
  has(html, "winner locked", "header notes the locked verdict");
  has(html, "Quick question", "renders variant A's subject");
  has(html, "15%", "renders A positive-reply rate (12/80 = 15%)");
  absent(html, "Leading", "a decided test does not show Leading");
}

console.log("AbResults — running test (auto-pause ON) renders Leading, no Winner");
{
  const html = renderToStaticMarkup(createElement(AbResults, { stats: [running] }));
  has(html, "Leading", "shows the provisional Leading tag");
  absent(html, "Winner", "no Winner while undecided");
  absent(html, "Paused", "nothing paused yet");
  has(html, "threads as", "empty-subject variant shows the Re: hint");
  has(html, "auto-winner on", "header shows the auto-pause-on caption");
}

console.log("AbResults — auto-pause OFF renders the manual caption");
{
  const html = renderToStaticMarkup(createElement(AbResults, { stats: [manual] }));
  has(html, "auto-pause off", "header flags auto-pause is off");
  has(html, "Leading", "still shows the current leader");
  absent(html, "Winner", "no auto-winner when off");
  has(html, "pick a winner yourself", "footer tells the user to decide manually");
}

console.log("AbResults — empty stats renders nothing");
{
  const html = renderToStaticMarkup(createElement(AbResults, { stats: [] }));
  if (html === "") {
    pass++;
    console.log("  ✓ no A/B nodes → renders nothing");
  } else {
    fail++;
    console.log(`  ✗ expected empty render, got: ${html.slice(0, 80)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
