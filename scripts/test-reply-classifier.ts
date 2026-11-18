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

import { runKeywordPrefilter, SEND_IT_FLAG, AUTO_SUBMITTED_FLAG, ADDRESS_CHANGE_FLAG } from "@/lib/replies/keyword-prefilter";
import { decideFinalClass } from "@/lib/replies/decide";
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

// ── CRITICAL: changed-address notices are auto-replies, never hot (task #860) ─
// A real one (2026-11-17, names changed) read as true_interest 0.82 and emailed
// the client. It must land in ooo by the prefilter alone; a person who writes
// back AND mentions a new address keeps their own class.
console.log("CRITICAL · changed-address notices (task #860)");
const MOVED =
  "Thanks very much for your email. I have transitioned to a new email server and can now be reached at jane@newfirmclean.com. Please update your contacts with this new email address to prevent any delays in receiving a response.\n\nThanks,\nJane\n\n555.010.0199\nwww.NewFirmClean.com\n\n";
for (const b of [
  MOVED,
  "Please note my email address has changed. Kindly update your records: jsmith@newco.com",
  "This mailbox is no longer monitored. I can now be reached at jsmith@newco.com.",
  "Hello, I have moved to a new email address. Please update your address book with jsmith@newco.com. Thank you!",
  "This email address will no longer be monitored after December 1. Please update your contact information.",
]) {
  crit(b, "ooo", `changed-address notice: "${b.slice(0, 50)}…"`);
  critNotHot(b, `changed-address notice is not hot: "${b.slice(0, 50)}…"`);
}
if (runKeywordPrefilter(MOVED, "jane@oldfirm.com").flags.includes(ADDRESS_CHANGE_FLAG)) passed++;
else { failed++; console.log("  ✗ CRIT changed-address notice must carry the address_change_phrase flag"); }
critNot("Interested! I can now be reached at jane@newfirmclean.com, please update your records.", "ooo", "an answer opening the reply is never an auto-reply");
critNot("Yes, please. I've moved to a new email address, please update your records: jane@newfirmclean.com", "ooo", "'Yes, please.' opening is never an auto-reply");
crit("I'm interested. I can now be reached at jane@newfirmclean.com, please update your records.", "true_interest", "interest + new address stays hot");
crit("Sure, send it to my new email address: jane@newfirmclean.com", "true_interest", "send-it to a new address stays hot");
crit("Do you work with commercial buildings? I can now be reached at jane@newfirmclean.com.", "qualifying_question", "a question + new address stays a question");
crit("Not interested. Please update your records, I can now be reached at jane@newfirmclean.com.", "not_interested", "a refusal + new address stays a refusal");
crit("I'm no longer with the company. Please contact mike@acme.co. This mailbox is no longer monitored.", "referral_forward", "a handoff to another person stays a referral");

// ── CRITICAL: clear rejections must NOT read as hot ──────────────────────────
console.log("CRITICAL · clear not-interested");
crit("Not interested, thanks.", "not_interested", "not interested");
crit("No thanks.", "unsubscribe", "no thanks is an opt-out (permanent suppression)");
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

// ── CRITICAL: "send it" is ALWAYS a positive reply (owner rule 2026-09-27) ───
// The send-it flag is a HARD true_interest override that beats Claude (decide.ts
// precedence 1b), so it must fire on every real request and on nothing else.
console.log("CRITICAL · \"send it\" always positive (hard override)");
function sendItFlag(body: string): boolean {
  return runKeywordPrefilter(body, "prospect@target.com").flags.includes(SEND_IT_FLAG);
}
const SIG = "\n\n--\nJohn Smith | Smith Law PLLC\nCONFIDENTIALITY NOTICE: This e-mail is intended only for the named recipient. If you received it in error, do not read, copy or send it; please send it back to the sender and delete it.";
for (const b of [
  "Send it",
  "Send it!",
  "send it over",
  "SEND IT",
  "Sure, send it over.",
  "Yes please send it",
  "Yes, please send.",
  "Send.",
  "Please send the report.",
  "Go ahead and send it.",
  "Send me the report",
  "Can you send it over?",
  "Could you send it to my paralegal? jane@smithlaw.com",
  "Would you mind sending it over?",
  "Feel free to send it over.",
  "I'd like you to send it.",
  "Why not, send it over.",
  "Shoot it over.",
  "Email it to me.",
  "Hi Daniel,\n\nNot sure we need this, but send it over and I'll take a look.\n\nThanks,\nJohn",
  "We're all set with SEO. But sure, send it.",
  "I'm not the right person, but send it anyway.",
  `Sure send it${SIG}`,
]) {
  if (sendItFlag(b) && det(b) === "true_interest") { passed++; continue; }
  failed++;
  console.log(`  ✗ CRIT send-it missed\n      flag ${sendItFlag(b)}, class ${det(b)}\n      "${b}"`);
}
for (const b of [
  "Don't send it.",
  "Please don't send anything.",
  "No need to send it, thanks.",
  "Not interested. Don't send it.",
  "I never asked you to send it.",
  "Who asked you to send this?",
  "Why did you send this to me?",
  "Why would you send it to me?",
  "Send it? No thanks.",
  "I'll send it to my partner and get back to you.",
  "You probably send this to every lawyer in Seattle.",
  "If you send this again, I'm reporting you.",
  "Send it to someone who cares.",
  "Not interested.\n\nJohn Smith\nIf you received this in error, please send it back to the sender and delete it.",
  `Not interested.${SIG}`,
  "I am out of the office until October 3 with limited access to email. For urgent matters, please email it to jane@firm.com.",
  "Please remove me from your list. Don't send it.",
  "Send it, then take me off your list.",
]) {
  if (!sendItFlag(b)) { passed++; continue; }
  failed++;
  console.log(`  ✗ CRIT send-it false positive\n      "${b}"`);
}
crit("Don't send it.", "not_interested", "negated send is a rejection");
crit("No need to send it, thanks.", "not_interested", "no need to send");
crit(`Not interested.${SIG}`, "not_interested", "disclaimer's 'send it back' is not a request");
crit("Send it, then take me off your list.", "unsubscribe", "opt-out beats send-it");
crit("I'm on vacation until Monday, but send it over and I'll look when I'm back.", "true_interest", "OOO words + send it is not an auto-reply");
for (const b of ["Please do not send it.", "No. Don't send.", "I don't want you to send it.", "Not necessary to send it.", "You don't need to send it."])
  crit(b, "not_interested", `negated send: "${b}"`);
for (const b of ["Why did you send this to me?", "Who asked you to send this?", "Why are you sending me this?", "Did I ask you to send it?", "Who said to send it?"])
  critNotHot(b, `hostile send question must not be hot: "${b}"`);

// ── CRITICAL: "no thanks" is an opt-out (owner rule 2026-09-28) ─────────────
// Our emails say: Reply "no thanks" and that's the last you'll hear from me. So a
// "no thanks" reply is suppressed permanently like "unsubscribe", but our OWN P.S.
// quoted back under a reply must never suppress a lead.
console.log("CRITICAL · \"no thanks\" = opt-out (permanent suppression)");
for (const b of ["no thanks", "No thanks.", "No, thank you.", "Thanks but no thanks", "No thanks, we already have an agency.", "no thanks!\n\nJohn Smith\nSmith Law"])
  crit(b, "unsubscribe", `opt-out: "${JSON.stringify(b)}"`);
const OUR_PS = "\n\nDaniel Tuccillo\nCo-Founder\nTuBe SEO\n\nP.S. Not for you? Reply \"no thanks\" and that's the last you'll hear from me.";
crit(`Sure, send it over!${OUR_PS}`, "true_interest", "our own quoted P.S. is not their opt-out");
critNot(`Interested, tell me more.${OUR_PS}`, "unsubscribe", "our P.S. under a positive reply never suppresses");
critNot(`Who is this?${OUR_PS}`, "unsubscribe", "our P.S. under a question never suppresses");
crit("No thanks needed, just send it!", "true_interest", "'no thanks needed' is a courtesy, not an opt-out");

// ── CRITICAL: signatures + legal footers are not the prospect talking ─────────
// Law-firm footers say "If you are not the intended recipient, do not forward
// this… please contact the sender" and signatures carry info@firm.com: a
// handoff phrase + an embedded email, i.e. a fake referral_forward (which a
// flow's reply_interested counts as interested). The referral checks read only
// the reply's own words; opt-out detection still reads everything.
console.log("CRITICAL · signatures / legal footers are not referrals");
const FOOTER = "\n\nSarah Lee\nLee & Associates, PLLC\ninfo@leelaw.com\n\nCONFIDENTIALITY NOTICE: This communication may contain privileged information. If you are not the intended recipient, do not forward this message; please contact the sender and delete it.";
crit(`Not interested.${FOOTER}`, "not_interested", "not interested + law-firm footer");
crit(`Please unsubscribe me.${FOOTER}`, "unsubscribe", "footer's 'do not forward this' can't mask an opt-out");
crit("I'm not the right person, please contact mike@acme.co", "referral_forward", "real referral");
crit(`I'm not the right person, please contact mike@acme.co.\n\nThanks,${FOOTER}`, "referral_forward", "real referral + signature + footer");
crit("I'm not the right person for this.\n\nBest,\nJohn Smith\nSmith Law\ninfo@smithlaw.com", "wrong_person_no_referral", "signature email is not a referral target");
crit("PRIVILEGED & CONFIDENTIAL\n\nI'm not the right person, please contact mike@acme.co.", "referral_forward", "legal banner above the reply is skipped");
crit("Hi Daniel,\n\nThanks!\n\nUnfortunately I'm not the right person. Please contact mike@acme.co.", "referral_forward", "mid-body 'Thanks!' is not a sign-off");
crit("I'm not the right person for this.\n\nThanks,\nJohn\n\nP.S. You'll want Mike: mike@acme.co", "referral_forward", "P.S. below the sign-off still counts");
critNot("Please contact me at 206-555-1212.", "wrong_person_no_referral", "'please contact me' is not wrong-person");
{
  const r = runKeywordPrefilter(`I'm not the right person, please contact mike@acme.co.\n\nThanks,${FOOTER}`, "sarah@leelaw.com");
  if (r.embedded_emails.join(",") === "mike@acme.co") passed++;
  else { failed++; console.log(`  ✗ CRIT referral target must be mike@acme.co only, got ${JSON.stringify(r.embedded_emails)}`); }
}
if (sendItFlag("PRIVILEGED & CONFIDENTIAL\n\nSure, send it over.")) passed++;
else { failed++; console.log("  ✗ CRIT send-it under a legal banner missed"); }

// decide.ts: the flag beats a confident Claude; without it Claude still rules.
const claudeSays = (cls: ReplyClass, confidence: number) =>
  ({ class: cls, confidence, reason: "test", referral_contact: null }) as Parameters<typeof decideFinalClass>[0]["claude"];
for (const [body, claude, expected, label] of [
  ["Send it", claudeSays("not_interested", 0.9), "true_interest", "send-it beats Claude not_interested 0.90"],
  ["Sure, send it over.", claudeSays("needs_review", 0.5), "true_interest", "send-it beats Claude needs_review"],
  ["Send it", null, "true_interest", "send-it with Claude down"],
  ["Don't send it.", claudeSays("not_interested", 0.9), "not_interested", "no flag: Claude rules"],
  ["Send it, then take me off your list.", claudeSays("true_interest", 0.9), "unsubscribe", "opt-out still beats everything"],
] as const) {
  const got = decideFinalClass({ prefilter: runKeywordPrefilter(body, "prospect@target.com"), claude }).final_class;
  if (got === expected) { passed++; continue; }
  failed++;
  console.log(`  ✗ CRIT decide: ${label}\n      expected ${expected}, got ${got}`);
}

// ── CRITICAL: automatic mail never rings the client (task #860) ──────────────
// The poller's header verdict (raw_payload.auto_submitted) rides in as a flag.
// A hot answer on automatic mail is held as needs_review with the hot class kept
// in the trail (so the owner gets the review push); every other class stands.
console.log("CRITICAL · automatic mail is never client-hot (task #860)");
const MOVED_NO_PHRASE = "Thanks very much for your email. Glad to hear from you; jane@newfirmclean.com is the best way to reach me going forward.";
for (const [body, auto, claude, expected, label] of [
  [MOVED_NO_PHRASE, true, claudeSays("true_interest", 0.82), "needs_review", "auto mail + Claude true_interest 0.82 → held"],
  [MOVED_NO_PHRASE, true, claudeSays("qualifying_question", 0.9), "needs_review", "auto mail + Claude qualifying_question → held"],
  [MOVED_NO_PHRASE, true, claudeSays("meeting_booked", 0.9), "needs_review", "auto mail + Claude meeting_booked → held"],
  [MOVED_NO_PHRASE, true, claudeSays("ooo", 0.9), "ooo", "auto mail + Claude ooo stands"],
  [MOVED_NO_PHRASE, true, claudeSays("referral_forward", 0.9), "referral_forward", "auto mail + Claude referral stands"],
  [MOVED_NO_PHRASE, false, claudeSays("true_interest", 0.82), "true_interest", "a person's mail: Claude still rules"],
  ["Sounds great, let's talk.", true, null, "needs_review", "auto mail + prefilter interest, Claude down → held"],
  ["Sure, send it over.", true, claudeSays("true_interest", 0.95), "needs_review", "auto mail: no send-it override"],
  ["Please unsubscribe me.", true, claudeSays("unsubscribe", 0.99), "unsubscribe", "auto mail: an opt-out still suppresses"],
  [MOVED, false, claudeSays("true_interest", 0.82), "ooo", "task #860's reply: the prefilter's ooo beats Claude's true_interest"],
] as const) {
  const prefilter = runKeywordPrefilter(body, "jane@oldfirm.com", { autoSubmitted: auto });
  const d = decideFinalClass({ prefilter, claude });
  const keptHot = expected !== "needs_review" || (claude === null ? prefilter.suggested_class !== null : d.claude_class === claude.class);
  if (d.final_class === expected && keptHot && prefilter.flags.includes(AUTO_SUBMITTED_FLAG) === auto) { passed++; continue; }
  failed++;
  console.log(`  ✗ CRIT decide: ${label}\n      expected ${expected}, got ${d.final_class} (claude_class ${d.claude_class}, flags ${prefilter.flags.join(",")})`);
}
if (!runKeywordPrefilter("Sure, send it over.", "x@y.com", { autoSubmitted: true }).flags.includes(SEND_IT_FLAG)) passed++;
else { failed++; console.log("  ✗ CRIT automatic mail must not carry the send-it flag"); }

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
