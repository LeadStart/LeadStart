// Every part that opens and closes in place does it the one smooth way (Daniel, 2026-10-22: "The expand and collapse
// … is glitchy and poor framerate on open and close … introduce a new universal styling rule"), a port of Forge's
// scripts/check-folds.mjs. Run by `npm run typecheck`. A fold is drawn by components/ui/fold.tsx, which opens it on
// one clock (src/lib/ui/fold.ts), turns it round from where it's drawn when pressed again mid-way, and glides its
// room in a page between explicit heights, clipped only while it moves. A menu or popover grows out of what was
// pressed with components/ui/grown.tsx on the same clock. This fails:
// - a control that opens and closes something (`aria-expanded`, or foldToggle's spread) with no <Fold> or <Grown> in
//   its component opening on the same state, unless NOT_FOLDS below says what it opens instead;
// - a turning chevron (`ls-chev`, `ls-chev-flip`) whose button doesn't say `aria-expanded`;
// - a <details>, which pops in and out in one frame;
// - a height, max-height, all or grid-template-rows transition, in a stylesheet, a Tailwind class (`transition-all`,
//   `transition-[height]`) or set from code, unless NOT_FOLD_GLIDES below says what it is;
// - the Fold losing its clock, its turning round from where it's drawn, or Reduce Motion.
import { attr, classesOf, componentOf, isFn, lineAt, names, parse, read, rel, sheets, selectors, spreads, tagName, tagOf, tsxFiles, utility, valueOf, at, ts } from './lib.mjs'

/** Controls that open something other than a fold, by component and first class: what each opens instead. */
const NOT_FOLDS = {}
/** Height glides that aren't a fold's, by selector or file: what each is. */
const NOT_FOLD_GLIDES = {
  'src/lib/ui/fold.ts': 'the fold itself',
  'src/lib/ui/keyboard-reveal.ts': "a text box's max-height, set once for the room above the keyboard (no transition)"
}

const unfolded = []
const blindChevs = []
const details = []
const glides = []
for (const file of tsxFiles()) {
  const { text, sf } = parse(file)
  const folds = new Map()
  const collect = (node) => {
    const tag = tagOf(node)
    if (tag && /^(Fold|Grown)$/.test(tagName(tag, sf))) {
      const [, fn] = componentOf(node)
      const list = folds.get(fn) ?? []
      list.push(names(valueOf(attr(tag, 'open'))))
      folds.set(fn, list)
    }
    ts.forEachChild(node, collect)
  }
  collect(sf)
  const inFold = (node) => {
    for (let n = node.parent; n; n = n.parent) {
      const t = tagOf(n)
      if (t && /^(Fold|Grown)$/.test(tagName(t, sf))) return true
    }
    return false
  }
  const visit = (node) => {
    const tag = tagOf(node)
    if (tag) {
      const name = tagName(tag, sf)
      if (name === 'details') details.push(at(file, sf, tag))
      const classes = classesOf(tag, sf)
      const expanded = attr(tag, 'aria-expanded')
      // foldToggle(open, toggle) spreads role, aria-expanded and the keys: its first argument is the state.
      const toggled = spreads(tag, sf).map((s) => s.match(/^foldToggle\((.+)\)$/s)?.[1]).find(Boolean)
      if (expanded || toggled) {
        const [comp, fn] = componentOf(node)
        const reads = expanded ? names(valueOf(expanded)) : new Set(toggled.split(',')[0].match(/[A-Za-z_$][\w$]*/g)?.filter((w) => w.length > 1) ?? [])
        const mine = folds.get(fn) ?? []
        // A Show all inside the fold it opens, a peek drawn apart (crm-pull-panel's collapsed button, a literal), or a
        // fold or menu in its component on its state.
        const ok = (!reads.size && (inFold(node) || mine.length > 0)) || mine.some((on) => [...reads].some((r) => on.has(r)))
        const key = [comp, ...classes.slice(0, 2)].filter(Boolean)
        const listed = NOT_FOLDS[key.join(' ')] ?? NOT_FOLDS[key.slice(0, 2).join(' ')] ?? NOT_FOLDS[comp]
        if (!ok && !listed) unfolded.push(`${at(file, sf, tag)} (${key.join(' ')})`)
      }
      const init = attr(tag, 'className')?.initializer
      const turns = !!init && !ts.isStringLiteral(init)
      if (turns && classes.some((c) => c === 'ls-chev' || c === 'ls-chev-flip')) {
        let says = false
        for (let n = node.parent; n && !says; n = n.parent) {
          const t = tagOf(n)
          if (t && (attr(t, 'onClick') || tagName(t, sf) === 'button' || spreads(t, sf).some((s) => /^foldToggle\(/.test(s)))) {
            says = !!attr(t, 'aria-expanded') || spreads(t, sf).some((s) => /^foldToggle\(/.test(s))
            break
          }
        }
        if (!says) blindChevs.push(at(file, sf, tag))
      }
      for (const c of classes) {
        const u = utility(c)
        if (u === 'transition-all' || (/^transition-\[/.test(u) && /(max-)?height|grid-template-rows/.test(u))) glides.push(`${at(file, sf, tag)} (${c})`)
      }
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) && /^\s*(max-)?height\s+\d/.test(node.text) && /transition/.test(node.parent?.parent?.getText(sf) ?? '')) {
      const [comp] = componentOf(node)
      if (!NOT_FOLD_GLIDES[comp] && !NOT_FOLD_GLIDES[rel(file)]) glides.push(`${at(file, sf, node)} (${comp ?? rel(file)})`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
for (const { file, text, rules } of sheets()) {
  for (const r of rules) {
    for (const d of r.body.match(/transition(-property)?\s*:[^;]*/g) ?? []) {
      const value = d.replace(/transition(-property)?\s*:/, ' ')
      if (/(^|[\s,])(max-)?height\b|grid-template-rows|(^|[\s,])all\b/.test(value) && !selectors(r.sel).some((s) => NOT_FOLD_GLIDES[s]) && !NOT_FOLD_GLIDES[rel(file)]) glides.push(`${rel(file)}:${r.line} (${r.sel.replace(/\s+/g, ' ')})`)
    }
  }
  void text, lineAt
}
const fold = read('src/lib/ui/fold.ts')
const comp = read('src/components/ui/fold.tsx')
const grown = read('src/components/ui/grown.tsx')
const lost = [
  [/export const OPEN_MS = 220;/.test(fold) && /export const CLOSE_MS = 160;/.test(fold) && /OPEN_EASE = "cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)"/.test(fold) && /CLOSE_EASE = "cubic-bezier\(0\.4, 0, 1, 1\)"/.test(fold), "the fold's clock: open over 220ms on the decelerating curve, closed over 160ms on an ease-in (src/lib/ui/fold.ts)"],
  [/if \(open !== committed\.current && !snap\.current && box\.current\) snap\.current = snapFold\(box\.current\);/.test(comp) && /getComputedStyle\(layer\)\.opacity/.test(fold), 'turning round from where it is drawn: its height and fades read as it is pressed, before the new state is drawn (fold.tsx, snapFold)'],
  [/reducedMotion\(\)/.test(comp), 'Reduce Motion: the end state at once (fold.tsx)'],
  [/const LATE_MS = 25;/.test(fold) && /a\.currentTime = Math\.min\(at, ms\)/.test(fold), 'a clock that moves on by the frames drawn, a late one counting LATE_MS at most (wholeGlide)'],
  [/IN_MS = 220/.test(grown) && /OUT_MS = 160/.test(grown) && /getComputedStyle\(node\)/.test(grown) && /prefers-reduced-motion/.test(grown), "a menu growing out of what was pressed on the same clock, turning round from where it's drawn, Reduce Motion (grown.tsx)"]
]
  .filter(([ok]) => !ok)
  .map(([, what]) => what)
if (unfolded.length) console.error(`Something that opens and closes in place without a <Fold> or <Grown> (2026-10-22: "glitchy and poor framerate on open and close"). Draw what it opens as <Fold open={…}> (in place) or <Grown open={…}> (a menu), or say in scripts/style/check-folds.mjs NOT_FOLDS what it opens instead:\n${unfolded.map((m) => `  ${m}`).join('\n')}`)
if (blindChevs.length) console.error(`A turning chevron whose button doesn't say aria-expanded, so this check can't see what it opens:\n${blindChevs.map((m) => `  ${m}`).join('\n')}`)
if (details.length) console.error(`A <details>, which opens and closes in one frame: a button and a <Fold> instead:\n${details.map((m) => `  ${m}`).join('\n')}`)
if (glides.length) console.error(`A height glide that isn't a Fold's (each frame lays out everything under it): use <Fold>, or say what it is in NOT_FOLD_GLIDES:\n${glides.map((m) => `  ${m}`).join('\n')}`)
if (lost.length) console.error(`The Fold lost what makes it smooth:\n${lost.map((m) => `  ${m}`).join('\n')}`)
if (unfolded.length || blindChevs.length || details.length || glides.length || lost.length) process.exit(1)
console.log('check-folds: every expand and collapse is a Fold or a Grown on one clock, no <details>, no height glide outside the fold')
