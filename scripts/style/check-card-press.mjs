// A card on a phone has one steady press (Daniel, 2026-10-23: "Need to fix press and hold effect on session cards on
// mobile … Needs to be added to styling guidelines globally for card interaction behavior on mobile"; his pick "A ·
// Steady lift"), a port of Forge's scripts/check-card-press.mjs. Run by `npm run typecheck`. Every card, row or tile
// a finger presses is pressed through src/lib/ui/card-press.ts (`ls-press` plus useCardPress's handlers): the chosen
// look from the moment a finger settles (90ms) until the press ends, a little give on `scale` while a hold counts, the
// menu handed off before the frame is drawn, the list held still after the hold, and no tap highlight of iOS's. The
// shared TableRow presses every row with an href. This fails:
// - a tag with `ls-press` that doesn't spread useCardPress's handlers (`{...press()}`);
// - a card pressed by hand (its own onTouchStart / onTouchMove / onTouchEnd in JSX);
// - a pressable card (cursor-pointer, rounded-xl or rounded-2xl, an onClick or href) with no `ls-press`, unless it
//   says why with data-no-press="…";
// - card-press.ts or globals.css losing the settle, the handoff, the hold-still, the one tile, the give on `scale`,
//   Reduce Motion or the tap highlight.
import { attr, attrNames, classesOf, componentOf, parse, read, spreads, tagName, tagOf, tsxFiles, utility, at, ts } from './lib.mjs'

const unspread = []
const handBuilt = []
const unpressed = []
for (const file of tsxFiles()) {
  if (file.endsWith('/lib/ui/card-press.ts')) continue
  const { text, sf } = parse(file)
  const pressers = new Set()
  const findPressers = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && /\buseCardPress\(/.test(n.initializer.getText(sf))) pressers.add(n.name.text)
    ts.forEachChild(n, findPressers)
  }
  findPressers(sf)
  const visit = (node) => {
    const tag = tagOf(node)
    if (tag) {
      const name = tagName(tag, sf)
      const classes = classesOf(tag, sf)
      const u = classes.map(utility)
      const where = at(file, sf, tag)
      const [comp] = componentOf(node)
      const touch = attrNames(tag).filter((n) => /^onTouch/.test(n))
      if (touch.length) handBuilt.push(`${where} (${comp}: ${touch.join(', ')})`)
      const pressed = spreads(tag, sf).some((s) => [...pressers].some((f) => new RegExp(`\\b${f}\\(`).test(s)))
      if (classes.includes('ls-press') && !pressed) unspread.push(`${where} (${comp ?? name})`)
      const card = u.includes('cursor-pointer') && u.some((c) => /^rounded-(xl|2xl)$/.test(c)) && (attr(tag, 'onClick') || attr(tag, 'href'))
      if (card && !classes.includes('ls-press') && !attr(tag, 'data-no-press')) unpressed.push(`${where} (${comp ?? name})`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  void text
}
const press = read('src/lib/ui/card-press.ts')
const table = read('src/components/ui/table.tsx')
const css = read('src/app/globals.css')
const lost = [
  [/export const SETTLE_MS = 90;/.test(press) && /put\(card, "lit"\);/.test(press) && /\}, SETTLE_MS\);/.test(press), 'a card lights only once a finger has settled on it (SETTLE_MS), so a swipe never lights one'],
  [/export const HOLD_MS = 450;/.test(press) && /export const HOLD_SLOP = 10;/.test(press) && /const TAP_MS = 140;/.test(press), "the hold's clock (450ms), its slop (10px) and a tap's brief press (140ms)"],
  [/flushSync\(\(\) => onHold\(card, \{ x: p\.x, y: p\.y \}\)\);/.test(press), "the hold hands the card's look to its menu before the frame is drawn (flushSync), so it never drops for a frame"],
  [/if \(lock\.current && e\.cancelable\) e\.preventDefault\(\);/.test(press) && /document\.addEventListener\("touchmove", move, \{ passive: false \}\);/.test(press), 'the list held still under the finger once the hold has fired'],
  [/useCardPress\(\)/.test(table) && /\bls-press\b/.test(table) && /\{\.\.\.press\(\)\}/.test(table), "the shared TableRow pressing every row with an href (table.tsx)"],
  [/\.ls-press\s*\{\s*-webkit-tap-highlight-color: transparent;/.test(css), "iOS's own tap highlight off on every pressable card (.ls-press)"],
  [/\.ls-press\[data-press\]\s*\{\s*background-color:/.test(css), 'the one tile on a pressed card (.ls-press[data-press])'],
  [/\.ls-press\[data-press="count"\]\s*\{\s*scale: 0\.975;/.test(css) && !/\.ls-press\[data-press[^{]*\{[^}]*\btransform:/.test(css), 'the give while the hold counts on `scale`, never `transform` (a card gliding to a new place keeps its glide)'],
  [/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,2000}?\.ls-press\[data-press="count"\]\s*\{\s*scale: none;/.test(css), 'Reduce Motion: no give']
]
  .filter(([ok]) => !ok)
  .map(([, what]) => what)
if (handBuilt.length) console.error(`A card with a press built by hand (2026-10-23: "you tap, hold and it flickers"). Spread useCardPress's handlers (src/lib/ui/card-press.ts) instead:\n${handBuilt.map((m) => `  ${m}`).join('\n')}`)
if (unspread.length) console.error(`A card marked ls-press that doesn't spread useCardPress's handlers ({...press()}), so nothing lights it:\n${unspread.map((m) => `  ${m}`).join('\n')}`)
if (unpressed.length) console.error(`A pressable card with no press from useCardPress (ls-press + {...press()}), or say why with data-no-press="…":\n${unpressed.map((m) => `  ${m}`).join('\n')}`)
if (lost.length) console.error(`A card lost what keeps its press steady:\n${lost.map((m) => `  ${m}`).join('\n')}`)
if (handBuilt.length || unspread.length || unpressed.length || lost.length) process.exit(1)
console.log('check-card-press: every pressable card is pressed through useCardPress, with the one steady look')
