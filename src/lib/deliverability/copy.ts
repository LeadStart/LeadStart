// Copy spam-signal scorer for cold email deliverability.
//
// CLIENT-SAFE — this module has NO node: imports and no npm deps beyond the two
// local modules below. It is deliberately split out of ./check.ts (which imports
// node:dns/promises) so the builder UI can import the scorer without dragging a
// node builtin into the client bundle.
//
// Two public functions:
//   findSpamMatches(text, field) — word-boundary-aware scan of one field,
//     spintax-aware (each spin branch is scanned individually).
//   scoreCopy(steps) — backward-compatible aggregate score + issues, now also
//     carrying a per-step breakdown with categorized matches + suggestions.

import { SPAM_PHRASES, type SpamCategory, type SpamSeverity } from "./spam-words";
import { parseSpintax, textSegments } from "../spintax";

export interface CopyIssue {
  severity: "warn" | "info";
  message: string;
}

export interface SpamMatch {
  phrase: string;
  category: SpamCategory;
  severity: SpamSeverity;
  alternatives?: string[];
  field: "subject" | "body";
  inSpintax: boolean;
}

export interface StepCopyResult {
  stepIndex: number;
  score: number;
  issues: CopyIssue[];
  matches: SpamMatch[];
}

export interface CopyScore {
  score: number; // 0–100, higher = cleaner
  issues: CopyIssue[];
  perStep: StepCopyResult[];
}

// ── Matcher precompilation (once at module load) ─────────────────────────────
//
// One RegExp per spam phrase. Word-boundary aware: we add a `\b` boundary only
// on an edge whose outermost character is a word character. That way "free"
// won't match inside "freelance", but "$$$" and "!!!" (non-word edges) still
// match anywhere. Internal whitespace in a phrase collapses to `\s+` so
// "act   now" or "act\nnow" still matches "act now".

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rich email editors autocorrect a straight apostrophe/quote into its curly
// glyph, which would silently defeat phrases like "this isn't spam". Fold the
// curly forms back to ASCII on the text we scan so those phrases still match.
function normalizeQuotes(s: string): string {
  return s.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
}

function isWordChar(ch: string): boolean {
  return /\w/.test(ch);
}

function buildMatcher(phrase: string): RegExp {
  // Collapse internal whitespace runs to a single space so we can split on it,
  // then join the escaped tokens with `\s+`.
  const collapsed = phrase.replace(/\s+/g, " ").trim();
  const body = collapsed
    .split(" ")
    .map((tok) => escapeRegex(tok))
    .join("\\s+");

  const first = collapsed[0] ?? "";
  const last = collapsed[collapsed.length - 1] ?? "";
  const left = isWordChar(first) ? "\\b" : "";
  const right = isWordChar(last) ? "\\b" : "";

  return new RegExp(left + body + right, "i");
}

interface CompiledPhrase {
  phrase: string;
  category: SpamCategory;
  severity: SpamSeverity;
  alternatives?: string[];
  matcher: RegExp;
}

const COMPILED: CompiledPhrase[] = SPAM_PHRASES.map((p) => ({
  phrase: p.phrase,
  category: p.category,
  severity: p.severity,
  alternatives: p.alternatives,
  matcher: buildMatcher(p.phrase),
}));

// ── Spam matching ────────────────────────────────────────────────────────────

/**
 * Scan one field's text for spam phrases. Spintax-aware: the text is broken into
 * literal segments via textSegments(); every matcher runs against each segment,
 * carrying that segment's inSpintax flag onto the match. So {free|complimentary}
 * flags the "free" branch with inSpintax:true, while plain prose is scanned as-is.
 *
 * Deduped to ONE match per (phrase, field): first occurrence wins, but a
 * non-spintax hit is preferred over a spintax one for the same phrase so the
 * suggestion reads naturally against the visible prose.
 */
export function findSpamMatches(text: string, field: "subject" | "body"): SpamMatch[] {
  const segments = textSegments(text);
  const byPhrase = new Map<string, SpamMatch>();

  for (const seg of segments) {
    const hay = normalizeQuotes(seg.text);
    for (const cp of COMPILED) {
      if (!cp.matcher.test(hay)) continue;
      const existing = byPhrase.get(cp.phrase);
      if (existing) {
        // Prefer a non-spintax hit if we previously only had a spintax one.
        if (existing.inSpintax && !seg.inSpintax) existing.inSpintax = false;
        continue;
      }
      byPhrase.set(cp.phrase, {
        phrase: cp.phrase,
        category: cp.category,
        severity: cp.severity,
        // Copy so a caller that sorts/mutates this array can't poison the
        // shared static SPAM_PHRASES data for every later scan.
        alternatives: cp.alternatives ? [...cp.alternatives] : undefined,
        field,
        inSpintax: seg.inSpintax,
      });
    }
  }

  return [...byPhrase.values()];
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Count real links (https?:// occurrences) in a chunk of text. */
function linkCount(text: string): number {
  return (text.match(/https?:\/\//g) || []).length;
}

/** ALL-CAPS words (len>2, has a letter) in a subject line. */
function capsWordCount(subject: string): number {
  return subject
    .split(/\s+/)
    .filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w)).length;
}

/** Spintax-validation warnings for one field, mapped to per-step CopyIssues. */
function spintaxIssues(text: string): CopyIssue[] {
  const issues: CopyIssue[] = [];
  const { warnings } = parseSpintax(text);
  for (const w of warnings) {
    if (w.code === "unbalanced_brace") {
      issues.push({ severity: "warn", message: "Unbalanced { } — check the spintax braces." });
    } else if (w.code === "empty_option") {
      issues.push({ severity: "info", message: w.message });
    } else if (w.code === "token_in_spintax") {
      issues.push({
        severity: "info",
        message:
          "A merge tag sits inside a spintax block — keep merge tags outside the braces to be safe.",
      });
    }
  }
  return issues;
}

// ── Scoring ────────────────────────────────────────────────────────────────────

/**
 * Heuristic spam-signal score for a sequence's copy.
 *
 * The aggregate `score` + `issues` preserve the exact behavior of the original
 * scoreCopy (same five checks, same wording, same 100 − warns×15 − infos×5
 * formula) so the existing card keeps reading the same. `perStep` is additive:
 * the same rules applied per step, plus per-step spam matches (with alternatives
 * + inSpintax) and spintax-validation issues for the builder UI.
 */
export function scoreCopy(steps: { subject: string; body: string }[]): CopyScore {
  // ── Aggregate (backward-compatible) ────────────────────────────────────────
  const issues: CopyIssue[] = [];
  const joined = steps.map((s) => `${s.subject}\n${s.body}`).join("\n");

  const aggLinks = linkCount(joined);
  if (aggLinks > 2) {
    issues.push({
      severity: "warn",
      message: `${aggLinks} links across the sequence — cold email lands best with 0–1.`,
    });
  }

  // Any high/med spam match across the sequence fires the single existing warn.
  // Scan each field of each step so spintax branches are covered too.
  const seqPhrases: string[] = [];
  const seenSeq = new Set<string>();
  for (const s of steps) {
    for (const m of [...findSpamMatches(s.subject, "subject"), ...findSpamMatches(s.body, "body")]) {
      if (m.severity === "low") continue;
      if (seenSeq.has(m.phrase)) continue;
      seenSeq.add(m.phrase);
      seqPhrases.push(m.phrase);
    }
  }
  if (seqPhrases.length > 0) {
    issues.push({
      severity: "warn",
      message: `Spam-trigger phrases present: ${seqPhrases.slice(0, 6).join(", ")}${seqPhrases.length > 6 ? "…" : ""}.`,
    });
  }

  steps.forEach((s, i) => {
    if (capsWordCount(s.subject) >= 2) {
      issues.push({ severity: "warn", message: `Step ${i + 1} subject uses ALL-CAPS words.` });
    }
  });

  if (/[!?]{2,}/.test(joined)) {
    issues.push({ severity: "info", message: "Repeated !!/?? punctuation reads as spammy." });
  }
  steps.forEach((s, i) => {
    if (s.body.trim().length < 40) {
      issues.push({ severity: "info", message: `Step ${i + 1} body is very short.` });
    }
  });

  const warns = issues.filter((x) => x.severity === "warn").length;
  const infos = issues.filter((x) => x.severity === "info").length;
  const score = Math.max(0, 100 - warns * 15 - infos * 5);

  // ── Per-step ────────────────────────────────────────────────────────────────
  const perStep: StepCopyResult[] = steps.map((s, i) => {
    const stepIssues: CopyIssue[] = [];
    const matches = [
      ...findSpamMatches(s.subject, "subject"),
      ...findSpamMatches(s.body, "body"),
    ];

    const stepLinks = linkCount(`${s.subject}\n${s.body}`);
    if (stepLinks > 2) {
      stepIssues.push({
        severity: "warn",
        message: `${stepLinks} links in this step — cold email lands best with 0–1.`,
      });
    }

    if (capsWordCount(s.subject) >= 2) {
      stepIssues.push({ severity: "warn", message: "Subject uses ALL-CAPS words." });
    }

    const hiMed = matches.filter((m) => m.severity !== "low").map((m) => m.phrase);
    if (hiMed.length > 0) {
      stepIssues.push({
        severity: "warn",
        message: `Spam-trigger phrases present: ${hiMed.slice(0, 6).join(", ")}${hiMed.length > 6 ? "…" : ""}.`,
      });
    } else {
      const low = matches.filter((m) => m.severity === "low").map((m) => m.phrase);
      if (low.length > 0) {
        stepIssues.push({
          severity: "info",
          message: `Mild spammy phrases: ${low.slice(0, 6).join(", ")}${low.length > 6 ? "…" : ""}.`,
        });
      }
    }

    if (/[!?]{2,}/.test(`${s.subject}\n${s.body}`)) {
      stepIssues.push({ severity: "info", message: "Repeated !!/?? punctuation reads as spammy." });
    }

    if (s.body.trim().length < 40) {
      stepIssues.push({ severity: "info", message: "Body is very short." });
    }

    // Spintax-validation issues (deduped per code, per field, folded together).
    const spinRaw = [...spintaxIssues(s.subject), ...spintaxIssues(s.body)];
    const seenSpin = new Set<string>();
    for (const issue of spinRaw) {
      if (seenSpin.has(issue.message)) continue;
      seenSpin.add(issue.message);
      stepIssues.push(issue);
    }

    const stepWarns = stepIssues.filter((x) => x.severity === "warn").length;
    const stepInfos = stepIssues.filter((x) => x.severity === "info").length;
    const stepScore = Math.max(0, 100 - stepWarns * 15 - stepInfos * 5);

    return { stepIndex: i, score: stepScore, issues: stepIssues, matches };
  });

  return { score, issues, perStep };
}
