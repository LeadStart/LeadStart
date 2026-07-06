#!/usr/bin/env node
/**
 * Unit tests for src/lib/spintax/index.ts — the deterministic spintax engine
 * (Milestone 1 of the spintax/spam-word plan).
 *
 * Covers:
 *   1. Literal-brace rule — {shrug}, {}, {{first_name}} pass through untouched
 *      with NO warning.
 *   2. Nesting — {a|{b|c} d} renders and countVariants multiplies/sums.
 *   3. Warnings — unbalanced_brace, empty_option, token_in_spintax fire.
 *   4. Determinism — same (template, seedKey) identical across 1000 calls.
 *   5. Distribution — 1000 distinct UUID-like seeds over {a|b} split ~50/50.
 *   6. Re:-coherence — a step-0 subject rendered twice with the same seedKey is
 *      byte-identical.
 *   7. countVariants respects the cap (explosive template) without hanging.
 *   8. sampleSpintax dedupes.
 *   9. textSegments flags inSpintax correctly and merges top-level literal runs.
 *
 * No network. No DB. Imports the REAL production module by relative path — tsx
 * resolves the .ts extension.
 *
 * Usage:
 *   npx tsx scripts/test-spintax.ts
 */

import {
  parseSpintax,
  hasSpintax,
  renderSpintax,
  countVariants,
  sampleSpintax,
  textSegments,
  fnv1a,
} from "../src/lib/spintax/index.ts";

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

function warnCodes(template: string): string[] {
  return parseSpintax(template).warnings.map((w) => w.code);
}

// ---------- 1. Literal-brace rule ----------
console.log("\n■ literal braces pass through untouched, no warning");
{
  for (const lit of ["{shrug}", "{}", "{abc}", "{{first_name}}"]) {
    assert(renderSpintax(lit, "seedX") === lit, `${lit} renders verbatim`);
    assert(warnCodes(lit).length === 0, `${lit} raises no warning`);
    assert(hasSpintax(lit) === false, `${lit} is not spintax`);
  }
  // A merge token containing a pipe must NOT be split into options.
  assert(renderSpintax("{{a|b}}", "s") === "{{a|b}}", "{{a|b}} token is opaque (pipe inside ignored)");
  assert(warnCodes("{{a|b}}").length === 0, "{{a|b}} raises no warning");
  // Mixed literal + token in a plain sentence.
  const mixed = "Hi {{first_name}}, {shrug} here.";
  assert(renderSpintax(mixed, "s") === mixed, "mixed literal+token sentence renders verbatim");
  assert(hasSpintax(mixed) === false, "mixed literal+token sentence has no spin block");
}

// ---------- 2. Nesting ----------
console.log("\n■ nesting renders and counts correctly");
{
  // {a|{b|c} d}: option "a" (1 variant) + option "{b|c} d" (2 variants) = 3.
  assert(countVariants("{a|{b|c} d}") === 3, "{a|{b|c} d} => 3 variants (1 + 2)");
  assert(hasSpintax("{a|{b|c} d}") === true, "{a|{b|c} d} is spintax");
  // Every render is one of the three concrete outputs.
  const legal = new Set(["a", "b d", "c d"]);
  for (let i = 0; i < 200; i++) {
    const out = renderSpintax("{a|{b|c} d}", "seed-" + i);
    assert(legal.has(out), `nested render "${out}" is a legal variant`);
    if (!legal.has(out)) break;
  }
  // Product across independent blocks: {a|b}{c|d} = 2 * 2 = 4.
  assert(countVariants("{a|b}{c|d}") === 4, "{a|b}{c|d} => 4 variants (2*2)");
  // Product with a nested factor: {a|b}{c|{d|e}} = 2 * (1 + 1... ) -> 2 * 3 = 6.
  assert(countVariants("{a|b}{x|{d|e}}") === 6, "{a|b}{x|{d|e}} => 6 variants (2*3)");
  // Single block: {a|b|c} = 3.
  assert(countVariants("{a|b|c}") === 3, "{a|b|c} => 3 variants");
  // No spin => exactly 1 variant.
  assert(countVariants("plain text {{tok}}") === 1, "spin-free template => 1 variant");
}

// ---------- 3. Warnings ----------
console.log("\n■ warnings fire correctly");
{
  assert(warnCodes("{a|b").includes("unbalanced_brace"), "unbalanced open brace warns");
  assert(warnCodes("hi } there").includes("unbalanced_brace"), "stray top-level } warns");
  assert(warnCodes("{a||b}").includes("empty_option"), "{a||b} raises empty_option");
  assert(warnCodes("{a|}").includes("empty_option"), "{a|} (trailing empty) raises empty_option");
  assert(warnCodes("{a|{{tok}}}").includes("token_in_spintax"), "{{tok}} inside spintax raises token_in_spintax");
  // token_in_spintax must NOT fire when the token is outside any spin block.
  assert(!warnCodes("{{tok}} {a|b}").includes("token_in_spintax"), "top-level {{tok}} does not raise token_in_spintax");
  // An unbalanced brace never throws and still renders.
  assert(renderSpintax("{a|b", "s") === "{a|b", "unbalanced template renders verbatim (never throws)");
  // Empty option renders as "".
  const emptyLegal = new Set(["a", "", "b"]);
  for (let i = 0; i < 60; i++) {
    assert(emptyLegal.has(renderSpintax("{a||b}", "e-" + i)), "{a||b} render is a/''/b");
  }
  // Warnings deduped by code — a template with two unbalanced closers reports once.
  assert(warnCodes("a } b } c").filter((c) => c === "unbalanced_brace").length === 1, "duplicate unbalanced warnings deduped");
}

// ---------- 4. Determinism ----------
console.log("\n■ determinism: same (template, seedKey) is identical across 1000 calls");
{
  const t = "{Hi|Hey|Hello} {{first_name}}, {quick|fast} {question|note} about {a|{b|c} d}";
  const seed = "contact-123:0:subject";
  const first = renderSpintax(t, seed);
  let stable = true;
  for (let i = 0; i < 1000; i++) {
    if (renderSpintax(t, seed) !== first) {
      stable = false;
      break;
    }
  }
  assert(stable, `1000 renders of the same (template, seedKey) are byte-identical ("${first}")`);
  // fnv1a is itself deterministic.
  assert(fnv1a("abc") === fnv1a("abc"), "fnv1a is deterministic");
  assert(fnv1a("abc") !== fnv1a("abd"), "fnv1a distinguishes near-identical input");
  assert(fnv1a("x") >>> 0 === fnv1a("x"), "fnv1a returns an unsigned 32-bit int");
}

// ---------- 5. Distribution ----------
console.log("\n■ distribution: 1000 UUID-like seeds over {a|b} split ~50/50");
{
  let a = 0;
  let b = 0;
  for (let i = 0; i < 1000; i++) {
    // UUID-like distinct seed keys.
    const seed = `${(i * 2654435761) >>> 0}-${i}-4${i}a-8${i}b-c${i}`;
    if (renderSpintax("{a|b}", seed) === "a") a++;
    else b++;
  }
  // Within +/-10% of 500.
  assert(a >= 450 && a <= 550, `option "a" count ${a} within 450-550 (${a}/${b})`);
  assert(b >= 450 && b <= 550, `option "b" count ${b} within 450-550 (${a}/${b})`);
  assert(a + b === 1000, "every seed produced a choice");
}

// ---------- 6. Re:-coherence ----------
console.log("\n■ Re:-coherence: step-0 subject renders byte-identically on re-render");
{
  const subject0 = "{Quick|Fast} question about {growth|scaling}";
  const seed = "contact-abc:0:subject";
  const original = renderSpintax(subject0, seed);
  // A follow-up "Re:" fallback re-renders step 0's subject with the same seed key.
  const reRender = renderSpintax(subject0, seed);
  assert(original === reRender, `"Re: ${original}" reproduces the step-0 subject byte-for-byte`);
  // Different seed keys (different contacts) may differ — but each is internally stable.
  const other = renderSpintax(subject0, "contact-xyz:0:subject");
  assert(renderSpintax(subject0, "contact-xyz:0:subject") === other, "a different contact's subject is also internally stable");
}

// ---------- 7. Variant cap ----------
console.log("\n■ countVariants respects the cap without hanging");
{
  // 50 independent 2-way blocks => 2^50 ~ 1.1e15; must clamp to the cap fast.
  const explosive = Array.from({ length: 50 }, () => "{a|b}").join("");
  const start = Date.now();
  const c = countVariants(explosive, 10000);
  const elapsed = Date.now() - start;
  assert(c === 10000, `explosive template clamps to cap 10000 (got ${c})`);
  assert(elapsed < 500, `cap computed quickly without enumerating (${elapsed}ms)`);
  // Custom cap honored.
  assert(countVariants(explosive, 32) === 32, "custom cap of 32 honored");
  // Below-cap templates count exactly.
  assert(countVariants("{a|b}{c|d}", 10000) === 4, "below-cap template counts exactly under a high cap");
}

// ---------- 8. sampleSpintax dedupes ----------
console.log("\n■ sampleSpintax dedupes");
{
  // {a|b} has only 2 distinct outputs — asking for 5 returns at most 2 distinct.
  const samples = sampleSpintax("{a|b}", 5, "base");
  const uniq = new Set(samples);
  assert(samples.length === uniq.size, "no duplicate samples returned");
  assert(samples.length <= 2, `at most 2 distinct outputs for {a|b} (got ${samples.length})`);
  assert(samples.every((s) => s === "a" || s === "b"), "samples are all legal outputs");
  // A spin-free template yields exactly one sample.
  const one = sampleSpintax("no spin here", 4, "base");
  assert(one.length === 1 && one[0] === "no spin here", "spin-free template yields a single sample");
  // n<=0 returns empty.
  assert(sampleSpintax("{a|b}", 0, "base").length === 0, "n=0 returns no samples");
  // A larger space returns n distinct samples.
  const many = sampleSpintax("{a|b}{c|d}{e|f}", 4, "base");
  assert(new Set(many).size === many.length, "larger space samples are distinct");
  assert(many.length === 4, `requested 4 distinct samples from an 8-variant space (got ${many.length})`);
}

// ---------- 8b. Block independence (regression) ----------
// Adjacent 2-option blocks that share a seedKey must NOT co-vary in lockstep.
// A single fnv1a of `${seedKey}#${blockIndex}` leaves the low bit perfectly
// correlated across adjacent indices; renderSpintax double-hashes to fix that.
// Guard it: across many seeds, {a|b}{c|d} must produce all 4 joint outcomes.
console.log("\n■ adjacent blocks vary independently (no lockstep)");
{
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    seen.add(renderSpintax("{a|b}{c|d}", "ind-" + i));
  }
  assert(seen.size === 4, `all 4 combinations of {a|b}{c|d} appear across seeds (got ${seen.size}: ${[...seen].sort().join(",")})`);
  // And three adjacent blocks reach more than the 2 lockstep patterns.
  const seen3 = new Set<string>();
  for (let i = 0; i < 800; i++) {
    seen3.add(renderSpintax("{a|b}{c|d}{e|f}", "ind3-" + i));
  }
  assert(seen3.size === 8, `all 8 combinations of {a|b}{c|d}{e|f} appear across seeds (got ${seen3.size})`);
}

// ---------- 9. textSegments ----------
console.log("\n■ textSegments flags inSpintax and merges top-level literal runs");
{
  // Top-level literal run around a spin block, with the token folded into the
  // surrounding literal (a {{token}} is opaque text, not spin).
  const segs = textSegments("Hello {{first_name}}, {quick|fast} note");
  // Expected: one merged top-level literal "Hello {{first_name}}, " (inSpintax:false),
  // then the two spin branches "quick" / "fast" (inSpintax:true), then " note".
  const topLiterals = segs.filter((s) => !s.inSpintax).map((s) => s.text);
  const spinLiterals = segs.filter((s) => s.inSpintax).map((s) => s.text);
  assert(topLiterals.includes("Hello {{first_name}}, "), "top-level literal run merges text + opaque token");
  assert(topLiterals.includes(" note"), "trailing top-level literal is captured");
  assert(spinLiterals.includes("quick") && spinLiterals.includes("fast"), "each spin branch is a separate inSpintax segment");
  assert(segs.filter((s) => s.inSpintax).every((s) => s.inSpintax === true), "spin-branch segments carry inSpintax:true");

  // A branch containing a token: the token stays inside the spin branch as text.
  const segs2 = textSegments("{a|{{tok}}}");
  assert(segs2.every((s) => s.inSpintax === true), "both branches of {a|{{tok}}} are inSpintax");
  assert(segs2.some((s) => s.text === "{{tok}}"), "opaque token appears verbatim inside its branch");

  // Consecutive top-level literal text (no spin) is one merged segment.
  const segs3 = textSegments("just plain prose with a {{tok}} in it");
  assert(segs3.length === 1 && segs3[0].inSpintax === false, "spin-free text is a single top-level segment");
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
