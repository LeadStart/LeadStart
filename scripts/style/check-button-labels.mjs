// A button's words sit in its middle (Daniel, 2026-10-29: "The "Fix it" text isn't centered in this view. Fix it. This
// needs to be biblically standardized to the button text"; his pick "Even, marks stay tucked"), a port of Forge's
// scripts/check-button-labels.mjs for Tailwind. Run by `npm run typecheck`. Every button laid out as flex or grid (a
// <button>, <a>, <Link>, <label> or a trigger, by the utilities on it or a stylesheet class it carries) says where its
// content sits across:
// - `justify-center-safe` (Tailwind's `justify-content: safe center`; `justify-*`, `place-content-*`, `justify-items-*`,
//   `place-items-*` count too): its words in its middle however wide it's drawn, longer words starting at its left;
// - or, for a row that reads from its left (a list's row, a menu's item), `text-left` or `justify-start` / `justify-between`;
// - in a column (`flex-col`), across is `items-*`.
// The shared Button, Badge and TabsTrigger say it in their base classes (checked to stay). A label around a form's
// field is the field's and isn't counted.
// And every button or chip has the same padding on its left and right (`pl-*` / `pr-*` / `px-*` / `p-*`, at every
// breakpoint), so its words sit in its middle. A round mark tucked into a pill's round end (a face, initials, a ring,
// a tick), or a bar whose button sits in its round end, says so on the tag: data-tucked="why". A row that reads from
// its left isn't held to it. The stylesheet's own classes are checked as Forge checks its (TUCKED by class).
// What a file can't see (a button drawn off its middle, uneven padding from a parent) is measured on the page by
// scripts/style/measure-button-labels.js, run by the measure gate.
import { attr, classesOf, declsOf, appliedOf, moduleIdentsOf, parse, read, rel, sheets, selectors, subjectClasses, tagName, tagOf, tsxFiles, utility, variantOf, at, ts } from './lib.mjs'

/** Stylesheet classes whose sides differ on purpose, with why. */
const TUCKED = {
  'ls-select': "a select field: its chevron sits in the padding on its right",
  'ls-select-sm': 'the small select field, the same',
  select: "the sequence editor's select field (flow.module.css), the same"
}
/** Tags that are buttons, and the classes the shared ones give before any className. */
const IMPLICIT = {
  button: '', a: '', Link: '', label: '',
  Button: 'inline-flex items-center justify-center-safe',
  Badge: 'inline-flex items-center justify-center-safe',
  TabsTrigger: 'inline-flex items-center justify-center-safe',
  SelectTrigger: 'flex items-center justify-between',
  AlertDialogAction: 'inline-flex items-center justify-center-safe',
  AlertDialogCancel: 'inline-flex items-center justify-center-safe',
  DropdownMenuTrigger: '', DialogTrigger: '', AlertDialogTrigger: '', DialogClose: '', PopoverTrigger: ''
}
const SAYS = /^(justify-(start|end|center|between|around|evenly|stretch|baseline|normal|center-safe|end-safe)|place-content-.+|justify-items-.+|place-items-.+|text-(left|start))$/
const READS = /^(justify-(start|between)|text-(left|start))$/

// ---------- the stylesheet's classes: how each is laid out, what it says, its sides ----------
const layout = new Map()
const of = (c) => layout.get(c) ?? (layout.set(c, { box: false, column: false, says: false, items: false }), layout.get(c))
const cssRules = sheets().flatMap(({ file, rules }) => rules.map((r) => ({ ...r, file })))
const sides = (body) => {
  let left, right
  for (const [, p, v] of body.matchAll(/(?:^|;)\s*(padding(?:-left|-right|-inline(?:-start|-end)?)?)\s*:\s*([^;]+)/g)) {
    const w = v.trim().replace(/\s*!important$/, '').split(/\s+/)
    if (p === 'padding') [left, right] = w.length === 4 ? [w[3], w[1]] : w.length >= 2 ? [w[1], w[1]] : [w[0], w[0]]
    else if (p === 'padding-inline') [left, right] = [w[0], w[1] ?? w[0]]
    else if (p === 'padding-left' || p === 'padding-inline-start') left = w[0]
    else right = w[0]
  }
  return { left, right }
}
const same = (a, b) => a === b || (parseFloat(a) === parseFloat(b) && (parseFloat(a) === 0 || a.replace(/[\d.-]/g, '') === b.replace(/[\d.-]/g, '')))
const rounded = new Set()
const reads = new Set()
const base = new Map()
for (const r of cssRules) {
  const decls = declsOf(r.body)
  const applied = appliedOf(r.body).map(utility)
  const box = decls.some(([p, v]) => p === 'display' && /^(?:inline-)?(?:flex|grid)\b/.test(v)) || applied.some((u) => /^(inline-)?(flex|grid)$/.test(u))
  const column = decls.some(([p, v]) => (p === 'flex-direction' && /^column/.test(v)) || (p === 'flex-flow' && /\bcolumn/.test(v))) || applied.some((u) => /^flex-col/.test(u))
  const says = decls.some(([p, v]) => /^(?:justify-content|place-content|justify-items|place-items)$/.test(p) || (p === 'text-align' && /^(?:left|start)\b/.test(v))) || applied.some((u) => SAYS.test(u))
  const items = decls.some(([p]) => p === 'align-items' || p === 'place-items') || applied.some((u) => /^(items-|place-items-)/.test(u))
  const round = /border-radius\s*:\s*(?:9{2,}px|100px|50%)\s*[;}]?/.test(r.body + ';')
  const left = /(?:^|;)\s*(?:text-align\s*:\s*(?:left|start)|justify-content\s*:\s*(?:flex-start|start|left|space-between))/.test(r.body) || applied.some((u) => READS.test(u))
  for (const sel of selectors(r.sel)) {
    const m = sel.match(/^[a-z]*\.([\w-]+)$/)
    if (m) {
      const s = sides(r.body)
      const b = base.get(m[1]) ?? {}
      base.set(m[1], { left: s.left ?? b.left, right: s.right ?? b.right })
    }
    for (const c of subjectClasses(sel)) {
      if (box || column || says || items) {
        const l = of(c)
        l.box ||= box; l.column ||= column; l.says ||= says; l.items ||= items
      }
      if (round) rounded.add(c)
      if (left) reads.add(c)
    }
  }
}

// ---------- the buttons ----------
const bad = []
const uneven = []
const onButtons = new Set()
let laidOut = 0
let padded = 0
const fieldIn = (node, sf) => {
  let hit = false
  const visit = (n) => {
    const t = tagOf(n)
    if (t && /^(input|select|textarea|Input|Select|Textarea|Checkbox|Switch|RadioGroup)$/.test(tagName(t, sf))) {
      const type = attr(t, 'type')?.initializer
      if (!(type && ts.isStringLiteral(type) && /^(file|hidden)$/.test(type.text))) hit = true
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return hit
}
for (const file of tsxFiles()) {
  const { text, sf } = parse(file)
  const idents = moduleIdentsOf(text)
  const visit = (node) => {
    const tag = tagOf(node)
    if (tag) {
      const name = tagName(tag, sf)
      if (name in IMPLICIT && !(name === 'label' && ts.isJsxElement(node) && fieldIn(node, sf))) {
        const cls = [...IMPLICIT[name].split(' ').filter(Boolean), ...classesOf(tag, sf, idents)]
        const u = cls.map(utility)
        for (const c of cls) onButtons.add(c)
        const cssL = cls.map((c) => layout.get(c)).filter(Boolean)
        const box = u.some((w) => /^(inline-)?(flex|grid)$/.test(w)) || cssL.some((l) => l.box)
        const column = u.some((w) => /^flex-col(-reverse)?$/.test(w)) || cssL.some((l) => l.column)
        const says = u.some((w) => SAYS.test(w)) || cssL.some((l) => l.says)
        const items = u.some((w) => /^(items-.+|place-items-.+)$/.test(w)) || cssL.some((l) => l.items)
        if (box) {
          laidOut++
          if (!(column ? items || says : says)) bad.push(`${at(file, sf, tag)}  <${name}> .${cls.slice(0, 8).join('.')}`)
        }
        // Even sides, at every breakpoint: a side's own utility beats px-*, which beats p-*; a variant's beats the base's.
        const chip = name in IMPLICIT || u.includes('rounded-full')
        // A block link or button (a card) reads from its left as a row does.
        const left = u.some((w) => READS.test(w)) || cls.some((c) => reads.has(c)) || (u.includes('block') && !u.includes('rounded-full'))
        if (chip && !left && !attr(tag, 'data-tucked')) {
          const pads = {}
          for (const c of cls) {
            const m = utility(c).match(/^(p|px|pl|pr|ps|pe)-(.+)$/)
            if (!m) continue
            const k = m[1] === 'ps' ? 'pl' : m[1] === 'pe' ? 'pr' : m[1]
            ;(pads[variantOf(c)] ??= {})[k] = m[2]
          }
          const b = pads[''] ?? {}
          for (const [v, p] of Object.entries(pads)) {
            const get = (side) => p[side] ?? p.px ?? p.p ?? b[side] ?? b.px ?? b.p
            const l = get('pl')
            const r = get('pr')
            if (l !== undefined && r !== undefined) padded++
            if (l !== undefined && r !== undefined && l !== r) uneven.push(`${at(file, sf, tag)}  <${name}>${v ? ` at ${v}` : ''} (left ${l}, right ${r})`)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
// The stylesheet's rules for classes on buttons or pills: the same on both sides.
for (const r of cssRules) {
  const own = sides(r.body)
  if (own.left === undefined && own.right === undefined) continue
  const cls = selectors(r.sel).flatMap(subjectClasses)
  if (!cls.some((c) => onButtons.has(c) || rounded.has(c))) continue
  if (cls.some((c) => reads.has(c))) continue
  if ([...r.sel.matchAll(/\.([\w-]+)/g)].some((m) => TUCKED[m[1]])) continue
  const b = cls.map((c) => base.get(c)).find(Boolean) ?? {}
  const left = own.left ?? b.left
  const right = own.right ?? b.right
  if (left === undefined || right === undefined || same(left, right)) continue
  uneven.push(`${rel(r.file)}:${r.line}  ${r.sel.replace(/\s+/g, ' ')}  (left ${left}, right ${right})`)
}
const lost = [
  [/justify-center-safe/.test(read('src/components/ui/button.tsx')), 'Button (ui/button.tsx) saying justify-center-safe in its base classes'],
  [/justify-center-safe/.test(read('src/components/ui/badge.tsx')), 'Badge (ui/badge.tsx) saying justify-center-safe in its base classes'],
  [/justify-center-safe/.test(read('src/components/ui/tabs.tsx')), 'TabsTrigger (ui/tabs.tsx) saying justify-center-safe in its base classes'],
  [/justify-between/.test(read('src/components/ui/select.tsx')), 'SelectTrigger (ui/select.tsx) saying justify-between in its base classes']
]
  .filter(([ok]) => !ok)
  .map(([, what]) => what)
if (uneven.length) console.error(`A button or chip with more padding on one side than the other (2026-10-29): its icon and words sit off its middle. Give it the same on both sides (keep its width: the two sides' average), or, for a round mark tucked into its round end or a bar's button tucked there, say why with data-tucked="…" on the tag (TUCKED for a stylesheet class):\n${uneven.map((u) => `  ${u}`).join('\n')}`)
if (bad.length) console.error(`A button laid out as flex or grid that doesn't say where its content sits across (2026-10-29): stretched wider than its words, they sit at its left. Give it justify-center-safe (a button), or text-left / justify-start / justify-between (a row that reads from its left); in a column, items-*:\n${[...new Set(bad)].map((b) => `  ${b}`).join('\n')}`)
if (lost.length) console.error(`A shared button lost its centring:\n${lost.map((l) => `  ${l}`).join('\n')}`)
if (uneven.length || bad.length || lost.length) process.exit(1)
console.log(`check-button-labels: ${laidOut} buttons laid out as flex or grid say where their words sit, and ${padded} padded buttons and chips have even sides`)
