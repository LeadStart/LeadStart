#!/usr/bin/env node
/**
 * Unit tests for src/lib/deliverability/copy.ts — the spintax-aware spam-word
 * matcher and the backward-compatible scoreCopy (Milestone 1).
 *
 * Covers:
 *   1. Word-boundary matching — "free" matches but "freelance" does NOT.
 *   2. Punctuation classics — "$$$" matches (non-word edges, no \b).
 *   3. Multi-word phrases — "act now" matches across single AND double space.
 *   4. Spintax-aware scan — {free|complimentary} yields a SpamMatch with
 *      inSpintax:true on the "free" branch.
 *   5. scoreCopy returns perStep with per-step scores.
 *   6. Aggregate parity — exact aggregate score + issue count on a documented
 *      spintax-free fixture, per the 100 − warns×15 − infos×5 formula.
 *   7. alternatives populated for known top offenders.
 *   8. Unbalanced-brace step yields the WARN spintax issue.
 *
 * No network. No DB. Imports the REAL production module by relative path.
 *
 * Usage:
 *   npx tsx scripts/test-copy-score.ts
 */

import { findSpamMatches, scoreCopy } from "../src/lib/deliverability/copy.ts";

// ---------- Test harness ----------
let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function phrases(text: string, field: "subject" | "body" = "body"): string[] {
  return findSpamMatches(text, field).map((m) => m.phrase);
}

// ---------- 1. Word-boundary matching ----------
console.log("\n■ word-boundary matching");
{
  assert(phrases("this service is free for you").includes("free"), '"free" matches as a standalone word');
  assert(!phrases("I do freelance work").includes("free"), '"free" does NOT match inside "freelance"');
  assert(!phrases("we offer freedom of choice").includes("free"), '"free" does NOT match inside "freedom"');
  // Boundary also holds at the start/end of the string.
  assert(phrases("free").includes("free"), '"free" matches the whole string');
  assert(phrases("Free consultation available").includes("free"), '"Free" matches case-insensitively');
  // A word phrase inside a larger word is not matched.
  assert(!phrases("cashflow analysis").includes("cash"), '"cash" does NOT match inside "cashflow"');
  assert(phrases("send cash today").includes("cash"), '"cash" matches as a standalone word');
}

// ---------- 2. Punctuation classics ----------
console.log("\n■ punctuation classics ($$$, repeated !/?)");
{
  assert(phrases("earn $$$ today").includes("$$$"), '"$$$" matches (non-word edges)');
  assert(phrases("$$$").includes("$$$"), '"$$$" matches alone');
  // A pair of $ should not spuriously match the triple.
  assert(!phrases("cost is $5 or $9").includes("$$$"), '"$$$" does not match scattered single $');
  // Runs of !/? are NOT spam phrases — the structural [!?]{2,} check owns that
  // signal, so they must not appear as a phrase match (avoids double-counting).
  assert(!phrases("wow!!! amazing").includes("!!!"), '"!!!" is not a spam phrase (structural check owns it)');
  const punct = scoreCopy([{ subject: "hi", body: "wow this is really great!! take a look sometime soon" }]);
  const punctInfos = punct.perStep[0].issues.filter((i) => /punctuation/i.test(i.message));
  assert(punctInfos.length === 1, "repeated !! scores exactly one punctuation info, not a phrase warn too");
}

// ---------- 2b. Smart-quote normalization ----------
console.log("\n■ smart-quote normalization");
{
  // Editors curl a straight apostrophe to U+2019; the check must still catch it.
  assert(phrases("honestly this isn’t spam at all").includes("this isn't spam"),
    '"this isn\'t spam" matches even with a curly apostrophe');
  assert(phrases("this isn't spam").includes("this isn't spam"),
    '"this isn\'t spam" matches with a straight apostrophe');
}

// ---------- 2c. Returned alternatives are caller-owned (no shared mutation) ----------
console.log("\n■ alternatives array is not shared mutable state");
{
  const first = findSpamMatches("free", "body").find((m) => m.phrase === "free");
  first?.alternatives?.push("HACKED");
  const second = findSpamMatches("free", "body").find((m) => m.phrase === "free");
  assert(!(second?.alternatives ?? []).includes("HACKED"),
    "mutating a returned alternatives array does not poison later scans");
}

// ---------- 3. Multi-word phrase whitespace normalization ----------
console.log("\n■ multi-word phrases across variable whitespace");
{
  assert(phrases("please act now to save").includes("act now"), '"act now" matches across a single space');
  assert(phrases("please act  now to save").includes("act now"), '"act now" matches across a double space');
  assert(phrases("please act\nnow to save").includes("act now"), '"act now" matches across a newline');
  // But not when the words are not adjacent.
  assert(!phrases("act on this now").includes("act now"), '"act now" does not match "act ... now" with words between');
}

// ---------- 4. Spintax-aware scan ----------
console.log("\n■ spintax-aware matching");
{
  const matches = findSpamMatches("{free|complimentary} trial for you", "body");
  const freeMatch = matches.find((m) => m.phrase === "free");
  assert(freeMatch !== undefined, '"free" branch of {free|complimentary} is flagged');
  assert(freeMatch?.inSpintax === true, "the flagged branch carries inSpintax:true");
  assert(freeMatch?.field === "body", "the match carries the field it was found in");
  // A plain (non-spintax) hit is marked inSpintax:false.
  const plain = findSpamMatches("this is free stuff", "subject").find((m) => m.phrase === "free");
  assert(plain?.inSpintax === false, "a non-spintax hit is inSpintax:false");
  // One match per (phrase, field): "free" appearing twice yields a single match.
  const dupe = findSpamMatches("free and free again", "body").filter((m) => m.phrase === "free");
  assert(dupe.length === 1, "one match per (phrase, field) even with repeats");
  // Non-spintax occurrence preferred over spintax for the same phrase.
  const both = findSpamMatches("free now and {free|no charge}", "body").find((m) => m.phrase === "free");
  assert(both?.inSpintax === false, "a non-spintax hit wins over a spintax hit for the same phrase");
}

// ---------- 5. perStep breakdown ----------
console.log("\n■ scoreCopy returns a per-step breakdown");
{
  const steps = [
    { subject: "Quick question", body: "A short friendly note that is definitely long enough to pass the length check easily." },
    { subject: "Follow up", body: "act now and buy now before this limited time offer ends today, hurry!" },
  ];
  const r = scoreCopy(steps);
  assert(Array.isArray(r.perStep) && r.perStep.length === 2, "perStep has one entry per step");
  assert(r.perStep[0].stepIndex === 0 && r.perStep[1].stepIndex === 1, "stepIndex is 0-based and ordered");
  assert(typeof r.perStep[0].score === "number", "per-step score is a number");
  assert(r.perStep[1].score < r.perStep[0].score, "the spammy step scores lower than the clean step");
  assert(r.perStep[1].matches.some((m) => m.phrase === "act now"), "the spammy step surfaces its matches");
  assert(typeof r.score === "number" && r.score >= 0 && r.score <= 100, "aggregate score is within 0-100");
}

// ---------- 6. Aggregate parity on a documented fixture ----------
console.log("\n■ aggregate parity: exact score + issue count on a spintax-free fixture");
{
  // Fixture: subject "hi", body "act now".
  //   - "act now" is a med-severity phrase → ONE aggregate warn
  //     ("Spam-trigger phrases present: act now.").
  //   - body "act now" trimmed length 7 < 40 → ONE aggregate info
  //     ("Step 1 body is very short.").
  //   - No >2 links, no ALL-CAPS (>=2 caps words), no [!?]{2,} punctuation.
  //   ⇒ warns=1, infos=1 ⇒ score = 100 − 1×15 − 1×5 = 80.
  const r = scoreCopy([{ subject: "hi", body: "act now" }]);
  const warns = r.issues.filter((i) => i.severity === "warn").length;
  const infos = r.issues.filter((i) => i.severity === "info").length;
  assert(warns === 1, `exactly 1 aggregate warn (got ${warns})`);
  assert(infos === 1, `exactly 1 aggregate info (got ${infos})`);
  assert(r.issues.length === 2, `exactly 2 aggregate issues total (got ${r.issues.length})`);
  assert(r.score === 80, `aggregate score is exactly 80 per 100−15−5 (got ${r.score})`);
  assert(
    r.issues.some((i) => i.severity === "warn" && i.message.includes("act now")),
    "the warn names the offending phrase",
  );
  assert(
    r.issues.some((i) => i.severity === "info" && /short/i.test(i.message)),
    "the info flags the short body",
  );

  // A fully clean fixture scores 100 with zero issues.
  const clean = scoreCopy([
    {
      subject: "A note on your onboarding",
      body: "Hi there, I run a small team and put together a short overview that might be useful to you. Happy to share it whenever suits.",
    },
  ]);
  assert(clean.score === 100, `a clean fixture scores exactly 100 (got ${clean.score})`);
  assert(clean.issues.length === 0, `a clean fixture has zero aggregate issues (got ${clean.issues.length})`);
}

// ---------- 7. alternatives populated for known offenders ----------
console.log("\n■ alternatives populated for known top offenders");
{
  const cases: Array<[string, boolean]> = [
    ["free", true],
    ["act now", true],
    ["touching base", true],
    ["risk-free", true],
    ["100% free", true],
  ];
  for (const [p, expectAlts] of cases) {
    const m = findSpamMatches(p, "body").find((x) => x.phrase === p);
    assert(m !== undefined, `"${p}" is matched`);
    const has = !!(m?.alternatives && m.alternatives.length > 0);
    assert(has === expectAlts, `"${p}" ${expectAlts ? "has" : "has no"} suggested alternatives`);
  }
}

// ---------- 8. Unbalanced-brace step yields the WARN spintax issue ----------
console.log("\n■ unbalanced brace surfaces a WARN spintax issue on the step");
{
  const r = scoreCopy([
    {
      subject: "hello there",
      body: "here is a body long enough to avoid the short-body flag entirely {a|b and then it never closes",
    },
  ]);
  const ps = r.perStep[0];
  const warn = ps.issues.find((i) => i.severity === "warn" && /unbalanced/i.test(i.message));
  assert(warn !== undefined, "unbalanced brace produces a WARN-severity spintax issue on the step");

  // A well-formed spintax step with a merge tag inside a spin block surfaces the
  // token_in_spintax info (not a warn).
  const r2 = scoreCopy([
    {
      subject: "hi",
      body: "a nicely sized body that is comfortably past the short threshold {Hi|Hey {{first_name}}} there",
    },
  ]);
  const info = r2.perStep[0].issues.find((i) => /merge tag/i.test(i.message));
  assert(info !== undefined && info.severity === "info", "merge tag inside spintax surfaces an INFO issue");
}

// ---------- Summary ----------
console.log("\n" + "─".repeat(40));
if (fail === 0) {
  console.log(`✓ ${pass} assertions passed`);
  process.exit(0);
} else {
  console.error(`✗ ${fail} failed, ${pass} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
