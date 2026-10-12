// The finder test's sampler: a seeded, stratified random draw, so the same
// 200 people go through every provider and a re-run draws the same list.
// Pure, no I/O; tested in scripts/test-finders.ts.

// mulberry32: a small seeded PRNG, enough for a reproducible shuffle.
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(rows: T[], rand: () => number): T[] {
  const out = rows.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Draw `sizes.known` rows for which `isKnown` is true and `sizes.misses` for
// which it is false, each stratum shuffled with its own derived seed and
// capped at what exists. Order: known first, then misses.
export function stratifiedSample<T>(
  rows: T[],
  isKnown: (row: T) => boolean,
  sizes: { known: number; misses: number },
  seed: number,
): T[] {
  const known = shuffle(rows.filter(isKnown), rng(seed)).slice(0, sizes.known);
  const misses = shuffle(rows.filter((r) => !isKnown(r)), rng(seed ^ 0x9e3779b9)).slice(0, sizes.misses);
  return [...known, ...misses];
}
