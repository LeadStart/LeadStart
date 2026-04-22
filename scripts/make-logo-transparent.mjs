// One-shot: convert public/leadstart-logo.png's white background to alpha,
// write a new file public/leadstart-logo-transparent.png. Uses a
// luminance-based "color-to-alpha" threshold so anti-aliased edges fade
// smoothly instead of stair-stepping.
//
// Run: node scripts/make-logo-transparent.mjs

import sharp from "sharp";

const SRC = "public/leadstart-logo.png";
const OUT = "public/leadstart-logo-transparent.png";

// Tunable thresholds. Pixels where min(R,G,B) >= HIGH are fully transparent.
// Pixels where min(R,G,B) <= LOW are fully opaque. In between the alpha
// interpolates linearly — this smooths the anti-aliased halo around the
// design so it doesn't leave a crunchy white ring on a dark bg.
const HIGH = 250;
const LOW = 210;

const { data, info } = await sharp(SRC)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const out = Buffer.from(data); // clone so we don't mutate sharp's buffer
let touched = 0;
for (let i = 0; i < out.length; i += 4) {
  const r = out[i];
  const g = out[i + 1];
  const b = out[i + 2];
  const minCh = Math.min(r, g, b);
  if (minCh >= HIGH) {
    out[i + 3] = 0;
    touched++;
  } else if (minCh > LOW) {
    const t = (minCh - LOW) / (HIGH - LOW); // 0..1
    out[i + 3] = Math.round((1 - t) * out[i + 3]);
    touched++;
  }
}

await sharp(out, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .png()
  .toFile(OUT);

console.log(
  `Wrote ${OUT} — ${info.width}×${info.height}, touched ${touched} pixels (${((touched / (info.width * info.height)) * 100).toFixed(1)}%)`
);
