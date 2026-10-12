// The email patterns pattern_mv guesses, in the order it tries them. Pure (no
// I/O, no Million Verifier import), so the settings card and the Enrichment
// Flow Map show the order straight from this code. Unit-tested by
// scripts/test-pattern-mv.ts and scripts/test-pattern-mv-guess-limit.ts.

// Strip a name part down to an email-local-part-safe token: drop diacritics,
// lowercase, keep [a-z0-9] only ("José" → "jose", "O'Brien" → "obrien").
function normalizePart(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeDomain(domain: string | null | undefined): string {
  return (domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

// The common decision-maker email permutations, most likely first:
//   first@ → flast@ → first.last@ → firstlast@ → last@ → f.last@
// Measured 2026-10-12 on all 635 Million Verifier-confirmed finds (32 runs: law
// firms, cleaning, fire protection): first@ 407, flast@ 141, first.last@ 51,
// firstlast@ 16, last@ 12, f.last@ 8. first@ led in every segment, and on
// catch-all domains the owner's published address was first@ 14 times in 17,
// first.last@ never. (Until then first.last@ came first.)
// Deduped, order preserved. Empty when there's no domain or no usable name.
export function generateEmailCandidates(
  first: string | null | undefined,
  last: string | null | undefined,
  domain: string | null | undefined,
): string[] {
  const f = normalizePart(first);
  const l = normalizePart(last);
  const d = normalizeDomain(domain);
  if (!d || (!f && !l)) return [];

  const locals: string[] = [];
  if (f) locals.push(f);
  if (f && l) locals.push(`${f[0]}${l}`);
  if (f && l) locals.push(`${f}.${l}`);
  if (f && l) locals.push(`${f}${l}`);
  if (l) locals.push(l);
  if (f && l) locals.push(`${f[0]}.${l}`);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const local of locals) {
    if (!local || seen.has(local)) continue;
    seen.add(local);
    out.push(`${local}@${d}`);
  }
  return out;
}

// The pattern order as labels ("first@", "flast@", …): the generator run on
// the literal names "first" / "last", for display.
export const EMAIL_PATTERN_LABELS: readonly string[] = generateEmailCandidates("first", "last", "domain").map((e) =>
  e.replace(/@domain$/, "@"),
);
