#!/usr/bin/env node
/**
 * Unit tests for the mailbox tag helpers (normalizeTags / normalizeTag / hasTag).
 * No network, no DB. Run: npx tsx scripts/test-mailbox-tags.ts
 */
import {
  normalizeTags,
  normalizeTag,
  hasTag,
  MAX_TAG_LEN,
  MAX_TAGS_PER_MAILBOX,
} from "../src/lib/mailboxes/tags.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${g}, want ${w})`);
  }
}

console.log("normalizeTags, basics");
eq(normalizeTags(["Agency", "Client A"]), ["Agency", "Client A"], "keeps order + casing");
eq(normalizeTags([]), [], "empty stays empty");
eq(normalizeTags(["  Agency  "]), ["Agency"], "trims whitespace");
eq(normalizeTags(["Agency", ""]), ["Agency"], "drops empty strings");
eq(normalizeTags(["Agency", "   "]), ["Agency"], "drops whitespace-only");

console.log("normalizeTags, dedupe is case-insensitive, first casing wins");
eq(normalizeTags(["Agency", "agency"]), ["Agency"], "dupe collapses");
eq(normalizeTags(["agency", "Agency", "AGENCY"]), ["agency"], "first-seen casing kept");
eq(normalizeTags(["A", "b", "a", "B"]), ["A", "b"], "interleaved dupes");

console.log("normalizeTags, untrusted input collapses to []");
eq(normalizeTags(null), [], "null");
eq(normalizeTags(undefined), [], "undefined");
eq(normalizeTags("Agency"), [], "a bare string is not an array");
eq(normalizeTags(123), [], "a number");
eq(normalizeTags([1, 2, "ok", null, {}]), ["ok"], "non-string members dropped");

console.log("normalizeTags, clamps length + count");
const long = "x".repeat(MAX_TAG_LEN + 10);
eq(normalizeTags([long])[0]?.length, MAX_TAG_LEN, `tag clamped to ${MAX_TAG_LEN} chars`);
const many = Array.from({ length: MAX_TAGS_PER_MAILBOX + 5 }, (_, i) => `t${i}`);
eq(normalizeTags(many).length, MAX_TAGS_PER_MAILBOX, `capped at ${MAX_TAGS_PER_MAILBOX} tags`);
// Clamping happens before dedupe, so two tags that differ only past the cap collapse.
eq(normalizeTags([long, long + "yy"]), [long.slice(0, MAX_TAG_LEN)], "clamp-then-dedupe");

console.log("normalizeTag, single value: trim + clamp, blanks/non-strings → ''");
eq(normalizeTag("Agency"), "Agency", "keeps casing");
eq(normalizeTag("  Agency  "), "Agency", "trims whitespace");
eq(normalizeTag("   "), "", "whitespace-only → empty");
eq(normalizeTag(""), "", "empty string → empty");
eq(normalizeTag(null), "", "null → empty");
eq(normalizeTag(undefined), "", "undefined → empty");
eq(normalizeTag(123), "", "number → empty");
eq(normalizeTag("x".repeat(MAX_TAG_LEN + 10)).length, MAX_TAG_LEN, `clamped to ${MAX_TAG_LEN} chars`);

console.log("hasTag, case-insensitive membership");
eq(hasTag(["Agency", "Client A"], "agency"), true, "matches ignoring case");
eq(hasTag(["Agency"], "  AGENCY "), true, "trims + ignores case");
eq(hasTag(["Agency"], "Client A"), false, "absent tag");
eq(hasTag([], "Agency"), false, "empty list");

console.log(`\nmailbox-tags: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
