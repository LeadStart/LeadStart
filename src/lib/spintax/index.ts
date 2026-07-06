// Spintax engine — deterministic per-recipient variation for cold email copy.
//
// This file has ZERO imports on purpose: it must be safe in the client bundle
// AND runnable under plain node type-stripping (no npm deps, no node: builtins,
// no enums — union string-literal types only).
//
// ── The one disambiguation rule ──────────────────────────────────────────────
//
//   {{ ... }}   is a MERGE TOKEN. It is consumed as ONE opaque text unit and
//               rendered verbatim. A `|` inside it NEVER splits spin options.
//               e.g. {{first_name}} stays exactly as written.
//
//   { ... }     is SPINTAX *only if* it contains a top-level `|`. Options are
//               split on top-level pipes and each option is parsed recursively:
//                 {Hi|Hey|Hello}  →  three options
//                 {a|{b|c} d}     →  nesting supported
//               A single-brace group with NO top-level pipe is re-emitted
//               verbatim as literal text, braces included. That single rule is
//               what leaves {shrug}, {}, and {{first_name}} untouched with no
//               special-casing and no warning.
//
// There is NO escape syntax. The top-level-pipe test is the ONLY disambiguator;
// a literal "{a|b}" meant to render verbatim is an accepted non-goal.
//
// Determinism (load-bearing — the native email sender relies on it): the chosen
// option for a spin node is a deterministic hash of (seedKey, blockIndex).
// Same (template, seedKey) always yields identical output. Math.random is
// forbidden anywhere in this file.
//
// The choice hash is DOUBLE-hashed — blockChoiceHash(seedKey, blockIndex) below
// remixes fnv1a(seedKey + "#" + blockIndex) through a second fnv1a pass. This is
// load-bearing for VARIETY, not just determinism: a single fnv1a of
// `${seedKey}#${blockIndex}` leaves the low bit perfectly correlated across
// adjacent block indices (appending "#0" vs "#1" flips only one input bit, and
// FNV-1a's final odd-prime multiply preserves that into a complementary low
// bit). Without the remix, two adjacent 2-option blocks in one template would
// ALWAYS co-vary — every recipient gets "first-of-each-pair" or
// "second-of-each-pair", collapsing half the intended variation. The second
// hash pass decorrelates the blocks while staying fully deterministic.

export type SpinNode =
  | { type: "text"; value: string }
  | { type: "spin"; blockIndex: number; options: SpinNode[][] };

export type SpintaxWarningCode = "unbalanced_brace" | "empty_option" | "token_in_spintax";

export interface SpintaxWarning {
  code: SpintaxWarningCode;
  message: string; // plain-language, owner-facing
}

export interface ParsedSpintax {
  nodes: SpinNode[];
  blockCount: number;
  warnings: SpintaxWarning[]; // deduped by code
}

export interface TextSegment {
  text: string;
  inSpintax: boolean;
}

// ── Hash ─────────────────────────────────────────────────────────────────────

/** 32-bit FNV-1a. Exported for tests. Returns an unsigned 32-bit integer. */
export function fnv1a(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// ── Warning messages (plain language) ────────────────────────────────────────

const WARNING_MESSAGES: Record<SpintaxWarningCode, string> = {
  unbalanced_brace: "Unbalanced { } — check the spintax braces.",
  empty_option: "A spintax option is empty — it will render as blank text.",
  token_in_spintax:
    "A merge tag sits inside a spintax block — keep merge tags outside the braces to be safe.",
};

// ── Parser ───────────────────────────────────────────────────────────────────
//
// Recursive-descent over the raw template. State is threaded through a small
// mutable context so blockIndex is assigned in document (pre-order) order and
// warnings can be recorded from anywhere in the descent.

interface ParseCtx {
  src: string;
  pos: number; // read cursor
  nextBlockIndex: number; // monotonically increasing across the whole document
  seenWarnings: Set<SpintaxWarningCode>;
  warnings: SpintaxWarning[];
  // Side channel: verbatim text of a single-brace group that turned out to be
  // literal (not spintax). Set by tryParseSpinGroup on a null return, consumed
  // immediately by parseNodes.
  _literal?: string;
}

function warn(ctx: ParseCtx, code: SpintaxWarningCode): void {
  if (ctx.seenWarnings.has(code)) return; // dedupe by code
  ctx.seenWarnings.add(code);
  ctx.warnings.push({ code, message: WARNING_MESSAGES[code] });
}

/**
 * Parse a run of nodes until we hit a delimiter that belongs to the caller.
 *
 * `stopAtGroupEnd` — true when we are inside a spin option: the run ends at a
 * top-level `|` (next option) or `}` (end of group), which are left unconsumed
 * for the caller to inspect. At the document top level it is false, so `|` and
 * `}` are ordinary characters (a stray top-level `}` is flagged + emitted).
 *
 * `depth` — 0 at the document top level, >0 inside any spin option. Used only
 * to decide whether a `{{token}}` should raise token_in_spintax.
 */
function parseNodes(ctx: ParseCtx, stopAtGroupEnd: boolean, depth: number): SpinNode[] {
  const nodes: SpinNode[] = [];
  let literal = ""; // accumulates plain characters until we flush a text node

  const flush = () => {
    if (literal.length > 0) {
      nodes.push({ type: "text", value: literal });
      literal = "";
    }
  };

  while (ctx.pos < ctx.src.length) {
    const ch = ctx.src[ctx.pos];

    // Caller's delimiters (only meaningful inside a spin option).
    if (stopAtGroupEnd && (ch === "|" || ch === "}")) {
      break;
    }

    if (ch === "{") {
      // Opaque merge token: "{{ ... }}" consumed whole, pipes inside ignored.
      if (ctx.src[ctx.pos + 1] === "{") {
        const token = readOpaqueToken(ctx);
        literal += token;
        if (depth > 0) warn(ctx, "token_in_spintax");
        continue;
      }

      // Single-brace group. Classify it as spintax vs literal.
      ctx._literal = undefined;
      const group = tryParseSpinGroup(ctx, depth);
      if (group === null) {
        // Not spintax (no top-level pipe, or unbalanced). The helper advanced
        // the cursor and stashed the verbatim text on ctx._literal — fold it
        // into the current literal run so it renders exactly as written.
        literal += ctx._literal ?? "";
        ctx._literal = undefined;
        continue;
      }
      flush();
      nodes.push(group);
      continue;
    }

    if (ch === "}" && !stopAtGroupEnd) {
      // Stray top-level closing brace — emit literally, flag once.
      warn(ctx, "unbalanced_brace");
      literal += ch;
      ctx.pos++;
      continue;
    }

    literal += ch;
    ctx.pos++;
  }

  flush();
  return nodes;
}

/**
 * Read a "{{ ... }}" opaque token starting at ctx.pos (which points at the
 * first "{"). Consumes through the closing "}}" and returns the verbatim text
 * including both brace pairs. If the closing "}}" is never found, consumes to
 * EOF, flags unbalanced_brace, and returns whatever was consumed.
 */
function readOpaqueToken(ctx: ParseCtx): string {
  const start = ctx.pos;
  ctx.pos += 2; // skip the opening "{{"
  while (ctx.pos < ctx.src.length) {
    if (ctx.src[ctx.pos] === "}" && ctx.src[ctx.pos + 1] === "}") {
      ctx.pos += 2; // consume the closing "}}"
      return ctx.src.slice(start, ctx.pos);
    }
    ctx.pos++;
  }
  // EOF before "}}" — treat the whole remainder as literal token text.
  warn(ctx, "unbalanced_brace");
  return ctx.src.slice(start, ctx.pos);
}

/**
 * Attempt to parse a single-brace group starting at ctx.pos (pointing at "{").
 *
 * Returns:
 *   - a `spin` SpinNode when the group is balanced AND has a top-level pipe;
 *   - `null` when the group is NOT spintax (no top-level pipe → literal like
 *     "{shrug}"/"{}", or unbalanced braces). On null the cursor is advanced past
 *     the consumed characters and their verbatim text is stashed on
 *     `ctx._literal` for parseNodes to fold into its literal run. Any warning
 *     is recorded on the OUTER ctx.
 *
 * Options are parsed in a fresh sub-context so a speculative parse that turns
 * out to be a plain literal group leaves no warnings or block indices behind.
 */
function tryParseSpinGroup(ctx: ParseCtx, depth: number): { type: "spin"; blockIndex: number; options: SpinNode[][] } | null {
  // Reserve this block's index in document order BEFORE recursing, so outer
  // blocks always get a lower index than inner ones (pre-order).
  const reservedIndex = ctx.nextBlockIndex;
  const groupStart = ctx.pos;

  // Speculatively parse assuming spintax: skip "{", parse option runs split on
  // top-level pipes until the matching "}".
  ctx.nextBlockIndex = reservedIndex + 1;
  ctx.pos++; // skip "{"

  const options: SpinNode[][] = [];
  let sawTopLevelPipe = false;

  // Parse the first option, then keep going while we see "|".
  // We must not commit warnings from a speculative parse that turns out to be a
  // no-pipe literal. To keep this simple and correct, we parse into a *sub*
  // context whose warnings/blockIndex we only merge back if this really is spin.
  const sub: ParseCtx = {
    src: ctx.src,
    pos: ctx.pos,
    nextBlockIndex: ctx.nextBlockIndex,
    seenWarnings: new Set(),
    warnings: [],
  };

  let closed = false;
  for (;;) {
    const optNodes = parseNodes(sub, true, depth + 1);
    options.push(optNodes);
    if (sub.pos >= sub.src.length) {
      // Ran off the end before a matching "}" — unbalanced.
      break;
    }
    const delim = sub.src[sub.pos];
    if (delim === "|") {
      sawTopLevelPipe = true;
      sub.pos++; // consume the pipe, parse next option
      continue;
    }
    if (delim === "}") {
      sub.pos++; // consume the closing brace
      closed = true;
      break;
    }
  }

  if (!sawTopLevelPipe || !closed) {
    // NOT spintax: either no top-level pipe (→ literal group like {shrug}) or
    // the braces never balanced (→ unbalanced). Roll back all speculative
    // state; re-emit verbatim. We restore nextBlockIndex to the reserved slot
    // so a real later block reuses this index (indices stay dense & document
    // ordered).
    ctx.nextBlockIndex = reservedIndex;

    if (!closed) {
      // Unbalanced brace: consume to wherever the speculative parse stopped
      // (EOF), emit everything verbatim, flag once on the OUTER context.
      warn(ctx, "unbalanced_brace");
      ctx.pos = ctx.src.length;
    } else {
      // Balanced but no pipe (e.g. "{shrug}", "{}"): consume just this group,
      // emit verbatim, NO warning — that is the rule.
      ctx.pos = sub.pos;
    }
    // Signal "literal" to the caller by returning null AFTER stashing the
    // verbatim text on the context for the caller to pick up.
    ctx._literal = ctx.src.slice(groupStart, ctx.pos);
    return null;
  }

  // Confirmed spintax: commit the speculative cursor and merge sub-warnings +
  // block-index high-water mark back into the outer context.
  ctx.pos = sub.pos;
  ctx.nextBlockIndex = sub.nextBlockIndex;
  for (const w of sub.warnings) warn(ctx, w.code);

  // Flag empty options (renders as ""). One warning covers the whole template.
  for (const opt of options) {
    if (opt.length === 0) {
      warn(ctx, "empty_option");
      break;
    }
  }

  return { type: "spin", blockIndex: reservedIndex, options };
}

/** Public parse entry point. */
export function parseSpintax(template: string): ParsedSpintax {
  const ctx: ParseCtx = {
    src: template,
    pos: 0,
    nextBlockIndex: 0,
    seenWarnings: new Set(),
    warnings: [],
  };
  const nodes = parseNodes(ctx, false, 0);
  return { nodes, blockCount: ctx.nextBlockIndex, warnings: ctx.warnings };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Deterministic option index for one spin block. Double-hashed to decorrelate
 * adjacent block indices (see the header note on determinism/variety). Pure
 * function of (seedKey, blockIndex) — same inputs always yield the same choice.
 */
function blockChoiceHash(seedKey: string, blockIndex: number): number {
  return fnv1a(fnv1a(seedKey + "#" + blockIndex).toString(36));
}

function renderNodes(nodes: SpinNode[], seedKey: string): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += node.value;
    } else {
      const idx = blockChoiceHash(seedKey, node.blockIndex) % node.options.length;
      out += renderNodes(node.options[idx], seedKey);
    }
  }
  return out;
}

/** Parse then deterministically render. Lenient — never throws. */
export function renderSpintax(template: string, seedKey: string): string {
  const { nodes } = parseSpintax(template);
  return renderNodes(nodes, seedKey);
}

/** True when the template contains at least one real spin block. */
export function hasSpintax(template: string): boolean {
  return parseSpintax(template).blockCount > 0;
}

// ── Variant counting ─────────────────────────────────────────────────────────
//
// variants(sequence) = product of child variants
// variants(text)     = 1
// variants(spin)     = sum over options of variants(option-sequence)
// Clamped to `cap` at every multiply/add and short-circuited — we never build
// or enumerate the full product.

function countNodes(nodes: SpinNode[], cap: number): number {
  let total = 1;
  for (const node of nodes) {
    if (node.type === "text") continue; // ×1
    let sum = 0;
    for (const opt of node.options) {
      sum += countNodes(opt, cap);
      if (sum >= cap) {
        sum = cap;
        break;
      }
    }
    total *= sum;
    if (total >= cap) return cap;
  }
  return total;
}

/** Number of distinct renders, clamped to `cap` (default 10000). */
export function countVariants(template: string, cap = 10000): number {
  const { nodes } = parseSpintax(template);
  return countNodes(nodes, cap);
}

// ── Sampling ─────────────────────────────────────────────────────────────────

/**
 * Deduped preview samples. Renders with seedKey `${baseSeed}:${i}` for
 * i = 0, 1, 2, … collecting distinct outputs until we have `n` or exhaust a
 * bounded number of attempts. Returns at most `n` outputs.
 */
export function sampleSpintax(template: string, n: number, baseSeed: string): string[] {
  if (n <= 0) return [];
  const { nodes } = parseSpintax(template);
  const seen = new Set<string>();
  const out: string[] = [];
  const maxAttempts = 4 * n + 8;
  for (let i = 0; i < maxAttempts && out.length < n; i++) {
    const rendered = renderNodes(nodes, baseSeed + ":" + i);
    if (!seen.has(rendered)) {
      seen.add(rendered);
      out.push(rendered);
    }
  }
  return out;
}

// ── Text segments (for the spam scan) ────────────────────────────────────────
//
// Pre-order traversal that accumulates MAXIMAL literal runs. Consecutive text
// nodes at the same nesting fold into one segment. Entering a spin node flushes
// the current run, then each option is walked as its own fresh run context with
// inSpintax:true (flushing between options and when a nested spin is hit).
// Phrases spanning a spin boundary are a documented non-goal.

function collectSegments(nodes: SpinNode[], inSpintax: boolean, segments: TextSegment[]): void {
  let run = "";
  const flush = () => {
    if (run.length > 0) {
      segments.push({ text: run, inSpintax });
      run = "";
    }
  };
  for (const node of nodes) {
    if (node.type === "text") {
      run += node.value;
    } else {
      flush(); // literal run ends at the spin boundary
      for (const opt of node.options) {
        collectSegments(opt, true, segments); // each option is a fresh run
      }
    }
  }
  flush();
}

/** Maximal literal runs, tagged by whether they sit inside spintax. */
export function textSegments(template: string): TextSegment[] {
  const { nodes } = parseSpintax(template);
  const segments: TextSegment[] = [];
  collectSegments(nodes, false, segments);
  return segments;
}
