// Labeled accuracy battery for the DETERMINISTIC reply classifier
// (runKeywordPrefilter). Run: npx tsx scripts/test-reply-classifier.ts
//
// Why test the prefilter and not the whole pipeline: the prefilter is a pure,
// free, deterministic function, so it's the layer CI can lock. It is also the
// layer that MUST be right on its own for two reasons:
//   1. Compliance: unsubscribe + ooo are HARD overrides (decide.ts) that run
//      before Claude and stand even when the model is off or the key is down.
//   2. Fallback: when Claude is off/errored, the prefilter's suggestion becomes
//      the final class (decide.ts precedence 4), so a prefilter false-HOT is a
//      real false alarm to the client.
//
// Two tiers:
//   • CRITICAL: hard assertions. A regression here fails the build (exit 1).
//     This is the "gate on false-HOT / missed-opt-out" the routing depends on.
//   • COVERAGE: a broad labeled set scored as a pass-rate + mismatch report.
//     NOT a build gate: many misses are acceptable needs_review fallbacks that
//     Claude corrects in the live path. It tracks accuracy drift for a human.

import { runKeywordPrefilter } from "@/lib/replies/keyword-prefilter";
import type { ReplyClass } from "@/types/app";

// The deterministic final class when Claude is off: the prefilter's suggestion,
// else needs_review. The two hard overrides (unsubscribe/ooo) are identical
// whether Claude runs or not, so this is exactly what CI needs to lock.
function det(body: string, sender: string | null = "prospect@target.com"): ReplyClass {
  return (runKeywordPrefilter(body, sender).suggested_class ?? "needs_review") as ReplyClass;
}

// The client-hot set: classes that ring the client's phone / send the client
// email. referral_forward is deliberately excluded (owner-facing since
// 2026-08-31), so "false-HOT" means landing in one of these three.
const CLIENT_HOT: ReplyClass[] = ["true_interest", "meeting_booked", "qualifying_question"];

let failed = 0;
let passed = 0;
function crit(body: string, expected: ReplyClass, label: string, sender?: string | null) {
  const got = det(body, sender ?? "prospect@target.com");
  if (got === expected) { passed++; return; }
  failed++;
  console.log(`  ✗ CRIT ${label}\n      expected ${expected}, got ${got}\n      "${body}"`);
}
function critNotHot(body: string, label: string) {
  const got = det(body);
  if (!CLIENT_HOT.includes(got)) { passed++; return; }
  failed++;
  console.log(`  ✗ CRIT ${label} (false-HOT)\n      got ${got}, must not be a client-hot class\n      "${body}"`);
}
function critNot(body: string, forbidden: ReplyClass, label: string) {
  const got = det(body);
  if (got !== forbidden) { passed++; return; }
  failed++;
  console.log(`  ✗ CRIT ${label}\n      got ${got}, must NOT be ${forbidden}\n      "${body}"`);
}

// ── CRITICAL: compliance: opt-outs MUST be caught (missed-opt-out gate) ──────
console.log("CRITICAL · opt-out detection (hard override → suppression)");
for (const b of [
  "Please unsubscribe me.",
  "Remove me from your list.",
  "Take me off your list.",
  "Take my name off your list.",
  "Stop emailing me.",
  "Stop contacting me please.",
  "STOP",
  "Do not contact me again.",
  "Please don't email me anymore.",
  "unsubscribe",
  "Lose my email.",
  "Delete my info.",
  "Delete my email address.",
  "Erase my details.",
  "I've reported this as spam.",
  "Marked as spam.",
  "This is spam.",
]) crit(b, "unsubscribe", `opt-out: "${b}"`);

// ── CRITICAL: opt-out must NOT fire on interested leads using "stop" ──────────
console.log("CRITICAL · opt-out false positives (interested leads with 'stop')");
critNot("Stop by my office when you're in town!", "unsubscribe", "'stop by' is not an opt-out");
critNot("Stop, this is amazing, how much?", "unsubscribe", "'Stop,' interjection is not an opt-out");
critNot("Don't stop reaching out, I'm keen.", "unsubscribe", "'don't stop' is not an opt-out");

// ── CRITICAL: out-of-office ───────────────────────────────────────────────────
console.log("CRITICAL · out-of-office");
crit("I'm out of office until Monday with limited email access.", "ooo", "OOO w/ return");
crit("On vacation through April 26. I will respond when I return.", "ooo", "OOO vacation");
crit("Automatic reply: I am currently traveling.", "ooo", "OOO auto-reply");

// ── CRITICAL: clear rejections must NOT read as hot ──────────────────────────
console.log("CRITICAL · clear not-interested");
crit("Not interested, thanks.", "not_interested", "not interested");
crit("No thanks.", "not_interested", "no thanks");
crit("We're all set.", "not_interested", "all set");
crit("Not a fit for us.", "not_interested", "not a fit");
critNotHot("Not interested, thanks.", "not-interested is not hot");
critNotHot("We're all set.", "all-set is not hot");

// ── CRITICAL: canonical hot signals ──────────────────────────────────────────
console.log("CRITICAL · canonical hot");
crit("This sounds interesting, what's pricing?", "true_interest", "interest + price Q");
crit("Yeah, I'd be interested. Send me more info.", "true_interest", "interested + more info");
crit("Give me a call, I'm curious.", "true_interest", "call me");
crit("Here's my Calendly: https://calendly.com/me/30min", "meeting_booked", "calendly link");
crit("I booked a slot for Tuesday at 3pm.", "meeting_booked", "booked a slot");
crit("How does your onboarding work?", "qualifying_question", "genuine question");
crit("Do you integrate with Salesforce?", "qualifying_question", "integration question");

// ── CRITICAL: referral routing ───────────────────────────────────────────────
console.log("CRITICAL · referral vs wrong-person");
crit("I'm not the right person, please contact Mike at mike@acme.co.", "referral_forward", "wrong-person + email");
crit("Looping in our ops lead, jane@acme.co, who handles this.", "referral_forward", "loop-in + email");
crit("I'm not the right person for this.", "wrong_person_no_referral", "wrong person, no email");

// ── CRITICAL: false-HOT guard: hostile / identity questions ─────────────────
console.log("CRITICAL · hostile-question false-HOT guard");
for (const b of [
  "Who is this?",
  "Who are you?",
  "How did you get my email?",
  "Where did you get my number?",
  "Did I sign up for this?",
  "Do I know you?",
  "Why are you emailing me?",
  "Is this spam?",
]) critNotHot(b, `hostile Q must not be hot: "${b}"`);

console.log(`\nCRITICAL result: ${passed} passed, ${failed} failed\n`);

// ── COVERAGE (informational) ─────────────────────────────────────────────────
// A broad labeled set. Misses are printed but do NOT fail the build; many are
// acceptable needs_review fallbacks that Claude resolves in the live path. This
// number is a drift tracker: watch it move over time, don't gate on it.
interface Cov { body: string; expected: ReplyClass; note?: string }
const COVERAGE: Cov[] = [
  { body: "yes please", expected: "true_interest", note: "idiom" },
  { body: "Go for it.", expected: "true_interest", note: "idiom" },
  { body: "I'm in.", expected: "true_interest", note: "idiom" },
  { body: "Sounds good, happy to chat.", expected: "true_interest" },
  { body: "Tell me more about how this works.", expected: "true_interest" },
  { body: "What's the cost?", expected: "true_interest", note: "price curiosity" },
  { body: "Invite sent for tomorrow 10am.", expected: "meeting_booked", note: "no scheduler word" },
  { body: "Reach out in Q4, not a priority right now.", expected: "objection_timing", note: "prefilter can't emit" },
  { body: "That's way too expensive for us.", expected: "objection_price", note: "prefilter can't emit" },
  { body: "Circle back after our fundraise.", expected: "objection_timing", note: "prefilter can't emit" },
  { body: "You should talk to my colleague Sarah (sarah@acme.co).", expected: "referral_forward", note: "no canned phrase" },
  { body: "Forwarding this to our head of marketing.", expected: "referral_forward", note: "no email in body" },
  { body: "This isn't my area, sorry.", expected: "wrong_person_no_referral" },
  { body: "Hard pass.", expected: "not_interested", note: "idiom" },
  { body: "I'll have to decline.", expected: "not_interested" },
  { body: "Not really interested to be honest.", expected: "not_interested", note: "split negation" },
  { body: "Unfortunately we can't move forward at this time.", expected: "not_interested", note: "polite decline" },
  { body: "How did you get my email? Delete it.", expected: "unsubscribe", note: "angry opt-out" },
];
let covPass = 0;
const covMiss: { c: Cov; got: ReplyClass }[] = [];
for (const c of COVERAGE) {
  const got = det(c.body);
  if (got === c.expected) covPass++;
  else covMiss.push({ c, got });
}
console.log("COVERAGE (informational, not a gate)");
console.log(`  ${covPass}/${COVERAGE.length} matched (${Math.round((covPass / COVERAGE.length) * 100)}%)`);
for (const m of covMiss) {
  console.log(`  · [${m.c.expected} → ${m.got}] "${m.c.body}"${m.c.note ? `  (${m.c.note})` : ""}`);
}

console.log("");
if (failed > 0) {
  console.log(`❌ ${failed} CRITICAL assertion(s) failed.`);
  process.exit(1);
}
console.log("✅ All CRITICAL assertions passed.");
