// Icons sit in the middle of what holds them (Daniel, 2026-10-28: "the icon … is not visually centered within the
// container. This must be resolved … in ALL master styling docs"; his pick "Icons plus badges"), a port of Forge's
// scripts/check-icon-centers.mjs. Run by `npm run typecheck`. Lucide draws some icons up to a unit off the middle of
// their own 24×24 (Forge measured 33 of 218), so:
// - Every Lucide icon LeadStart imports has its ink centred: either Lucide draws it so, or `src/app/icon-centers.css`
//   moves its drawing back inside its own box (`svg.lucide-<name> > * { translate }`, in the icon's own units, so it
//   holds at every size and when the icon is turned). That file is written from Lucide's own shapes:
//   `node scripts/style/check-icon-centers.mjs --write` after adding an icon this check names. Both roots (layout.tsx
//   and global-error.tsx) import it. Lucide's Play is left as drawn (OPTICAL): a triangle sits toward its point.
// - Every icon drawn by hand (an `<svg viewBox>` of fixed shapes) has its ink's middle at its viewBox's middle, so
//   centring its box centres what you see. Drawings that aren't an icon in a holder are named in NOT_ICONS with why.
// The ink is the shapes' outline (curves and arcs followed closely) grown by half the stroke, as the browser draws it.
// What a holder does to an icon (its padding, a box off its middle) is measured on the page by
// scripts/style/measure-icon-centers.js, run by the measure gate.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codeFiles, lineAt, read, rel, repo, tsxFiles } from './lib.mjs'

const CSS = join(repo, 'src/app/icon-centers.css')
const lucide = join(repo, 'node_modules/lucide-react/dist/esm')
/** Off by less than this many units of its viewBox (a 24 one: 0.04px at 18px) counts as centred. */
const TOL = 0.05
const OPTICAL = { play: "a triangle sits toward its point to look centred, and Lucide's Play is drawn that way" }
/** Hand-drawn SVGs that aren't an icon in a ring, box or button, by a class or attribute they carry. */
const NOT_ICONS = {
  'ls-spark': 'a sparkline, drawn to its data (charts/sparkline.tsx)',
  'ls-funnel': 'a funnel chart, drawn to its data (charts/step-funnel.tsx)',
  'ls-bounce': "the bounce loader's dots, drawn to move (ui/bounce-loader.tsx)",
  'ls-flow-edge': "the enrichment flow map's connectors, drawn to meet their nodes (workflows/enrichment-flow-map.tsx)",
  'ls-flow-wire': "the sequence editor's wires, drawn to meet their steps (campaigns/flow/flow-editor.tsx)"
}

// ---------- ink ----------
function pathPoints(d) {
  const toks = [...d.matchAll(/[a-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)].map((m) => m[0])
  const pts = []
  let i = 0
  let cmd = ''
  let last = ''
  let x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, qx = 0, qy = 0
  const n = () => parseFloat(toks[i++])
  const flag = () => {
    const t = toks[i]
    if (t.length > 1 && /^[01]/.test(t)) {
      toks[i] = t.slice(1)
      return +t[0]
    }
    i++
    return +t
  }
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    for (let k = 1; k <= 64; k++) {
      const t = k / 64
      const u = 1 - t
      pts.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3])
    }
  }
  const quad = (x1, y1, x2, y2) => {
    for (let k = 1; k <= 64; k++) {
      const t = k / 64
      const u = 1 - t
      pts.push([u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2])
    }
  }
  const arc = (rx, ry, rot, large, sweep, x2, y2) => {
    rx = Math.abs(rx)
    ry = Math.abs(ry)
    if (!rx || !ry) return void pts.push([x2, y2])
    const phi = (rot * Math.PI) / 180
    const c = Math.cos(phi)
    const s = Math.sin(phi)
    const dx = (x - x2) / 2
    const dy = (y - y2) / 2
    const x1p = c * dx + s * dy
    const y1p = -s * dx + c * dy
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if (lam > 1) {
      rx *= Math.sqrt(lam)
      ry *= Math.sqrt(lam)
    }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    let co = Math.sqrt(Math.max(0, num / den))
    if (large === sweep) co = -co
    const cxp = (co * rx * y1p) / ry
    const cyp = (-co * ry * x1p) / rx
    const ox = c * cxp - s * cyp + (x + x2) / 2
    const oy = s * cxp + c * cyp + (y + y2) / 2
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if (!sweep && dt > 0) dt -= 2 * Math.PI
    if (sweep && dt < 0) dt += 2 * Math.PI
    for (let k = 1; k <= 256; k++) {
      const t = t1 + (dt * k) / 256
      pts.push([ox + rx * Math.cos(t) * c - ry * Math.sin(t) * s, oy + rx * Math.cos(t) * s + ry * Math.sin(t) * c])
    }
  }
  while (i < toks.length) {
    if (/[a-z]/i.test(toks[i])) cmd = toks[i++]
    const relc = cmd === cmd.toLowerCase()
    const ox = relc ? x : 0
    const oy = relc ? y : 0
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + n(); y = oy + n(); sx = x; sy = y
        pts.push([x, y])
        cmd = relc ? 'l' : 'L'
        break
      case 'L':
        x = ox + n(); y = oy + n()
        pts.push([x, y])
        break
      case 'H':
        x = ox + n()
        pts.push([x, y])
        break
      case 'V':
        y = oy + n()
        pts.push([x, y])
        break
      case 'C': {
        const a = [ox + n(), oy + n(), ox + n(), oy + n(), ox + n(), oy + n()]
        cubic(...a)
        ;[cx, cy, x, y] = a.slice(2)
        break
      }
      case 'S': {
        const smooth = /[CS]/i.test(last)
        const a = [ox + n(), oy + n(), ox + n(), oy + n()]
        cubic(smooth ? 2 * x - cx : x, smooth ? 2 * y - cy : y, ...a)
        ;[cx, cy, x, y] = a
        break
      }
      case 'Q': {
        const a = [ox + n(), oy + n(), ox + n(), oy + n()]
        quad(...a)
        ;[qx, qy, x, y] = a
        break
      }
      case 'T': {
        const smooth = /[QT]/i.test(last)
        const c1 = [smooth ? 2 * x - qx : x, smooth ? 2 * y - qy : y]
        const a = [ox + n(), oy + n()]
        quad(...c1, ...a)
        ;[qx, qy] = c1
        ;[x, y] = a
        break
      }
      case 'A': {
        const rx = n(), ry = n(), rot = n()
        const large = flag()
        const sweep = flag()
        const ex = ox + n()
        const ey = oy + n()
        arc(rx, ry, rot, large, sweep, ex, ey)
        x = ex; y = ey
        break
      }
      case 'Z':
        x = sx; y = sy
        pts.push([x, y])
        break
      default:
        throw new Error(`path command "${cmd}" in "${d}"`)
    }
    last = cmd
  }
  return pts
}
function shapePoints(tag, a) {
  const f = (k) => parseFloat(a[k] ?? 0)
  if (tag === 'path') return pathPoints(a.d)
  if (tag === 'rect') return [[f('x'), f('y')], [f('x') + f('width'), f('y') + f('height')]]
  if (tag === 'circle') return [[f('cx') - f('r'), f('cy') - f('r')], [f('cx') + f('r'), f('cy') + f('r')]]
  if (tag === 'ellipse') return [[f('cx') - f('rx'), f('cy') - f('ry')], [f('cx') + f('rx'), f('cy') + f('ry')]]
  if (tag === 'line') return [[f('x1'), f('y1')], [f('x2'), f('y2')]]
  const v = (a.points ?? '').match(/-?(?:\d+\.?\d*|\.\d+)/g)?.map(parseFloat) ?? []
  const out = []
  for (let k = 0; k + 1 < v.length; k += 2) out.push([v[k], v[k + 1]])
  return out
}
function inkBox(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [tag, a, sw] of shapes) {
    const w = sw / 2
    for (const [x, y] of shapePoints(tag, a)) {
      x0 = Math.min(x0, x - w); y0 = Math.min(y0, y - w); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + w)
    }
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
}
const round = (v) => Math.round(v * 1000) / 1000 || 0

// ---------- the Lucide icons LeadStart uses ----------
const iconFile = {}
for (const m of readFileSync(join(lucide, 'lucide-react.js'), 'utf8').matchAll(/export \{([^}]*)\} from '\.\/icons\/([\w-]+)\.js'/g))
  for (const n of m[1].matchAll(/default as (\w+)/g)) iconFile[n[1]] = m[2]
const used = new Map()
const problems = []
for (const file of codeFiles()) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g))
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (iconFile[name]) used.set(iconFile[name], name)
    }
  if (/import\s+\*\s+as\s+\w+\s+from\s*["']lucide-react["']/.test(text)) problems.push(`${rel(file)}: imports every Lucide icon at once; import the ones it draws by name, so this check can centre them`)
}
const rules = []
for (const [file, name] of [...used].sort()) {
  const text = readFileSync(join(lucide, 'icons', `${file}.js`), 'utf8')
  const id = text.match(/createLucideIcon\("([\w-]+)"/)?.[1] ?? file
  const shapes = [...text.matchAll(/\[\s*"(\w+)",\s*\{([^}]*)\}\s*\]/g)].map((m) => {
    const a = {}
    for (const kv of m[2].matchAll(/(\w+): "([^"]*)"/g)) a[kv[1]] = kv[2]
    return [m[1], a, 2]
  })
  const b = inkBox(shapes)
  const dx = round(12 - b.cx)
  const dy = round(12 - b.cy)
  if (OPTICAL[id] || (Math.abs(dx) < TOL && Math.abs(dy) < TOL)) continue
  if (b.x0 + dx < 0 || b.x1 + dx > 24 || b.y0 + dy < 0 || b.y1 + dy > 24) problems.push(`Lucide's ${name} (${id}) can't be centred inside its own 24×24 without clipping; centre it in its holder instead and add it to OPTICAL with why`)
  rules.push({ id, name, dx, dy })
}
const head = `/* Lucide icons drawn off the middle of their own 24×24, moved back so their ink is centred (the icon-centres rule,
   Daniel, 2026-10-28). Written by \`node scripts/style/check-icon-centers.mjs --write\` from Lucide's own shapes;
   \`npm run typecheck\` fails when an icon LeadStart imports is missing here or Lucide redraws one. The move is in the
   icon's own units, so it holds at every size and when an icon is turned; the box stays where its holder centres it. */
`
const want = head + rules.map((r) => `/* ${r.name} */\nsvg.lucide-${r.id} > * {\n  translate: ${r.dx ? `${r.dx}px` : 0} ${r.dy ? `${r.dy}px` : 0};\n}\n`).join('')
if (process.argv.includes('--write')) {
  writeFileSync(CSS, want)
  console.log(`icon-centers.css: ${rules.length} of ${used.size} Lucide icons moved to their middle`)
} else {
  let have = ''
  try {
    have = readFileSync(CSS, 'utf8')
  } catch {
    /* missing: told below */
  }
  if (have !== want) {
    const missing = rules.filter((r) => !have.includes(`svg.lucide-${r.id} > * {\n  translate: ${r.dx ? `${r.dx}px` : 0} ${r.dy ? `${r.dy}px` : 0};`))
    problems.push(`src/app/icon-centers.css is out of date with the Lucide icons LeadStart uses${missing.length ? ` (${missing.map((r) => r.name).join(', ')} off their middle)` : ''}: run \`node scripts/style/check-icon-centers.mjs --write\``)
  }
  for (const root of ['src/app/layout.tsx', 'src/app/global-error.tsx']) if (!/import "\.\/icon-centers\.css"/.test(read(root))) problems.push(`${root} doesn't import "./icon-centers.css"`)
  // Lone labels sit on their ink: the routine, the <Ink> part that joins a span to it once React has mounted it, and
  // its CSS stay (src/lib/ui/ink-center.ts, src/components/ui/ink.tsx). No span joins from a DOM watch: a slide written
  // on server HTML before React hydrated it made React 19 report an attribute mismatch on every inbox row (2026-10-31).
  const ink = read('src/lib/ui/ink-center.ts')
  for (const [what, re] of [['the canvas reading', /measureText\(/], ['the ink box', /actualBoundingBoxLeft/], ['the slide', /style\.translate = /], ['the holder watch', /new ResizeObserver\(/], ['the registry', /export function inkRegister\(/], ['the fonts wait', /fonts\?\.ready/]]) if (!re.test(ink)) problems.push(`src/lib/ui/ink-center.ts lost ${what}`)
  const inkPart = read('src/components/ui/ink.tsx')
  if (!/useLayoutEffect\(/.test(inkPart) || !/inkRegister\(el\)/.test(inkPart) || !/inkRelease\(el\)/.test(inkPart)) problems.push('src/components/ui/ink.tsx no longer registers its span from a layout effect (the slide must never land on server HTML before React hydrates it)')
  if (/MutationObserver/.test(ink)) problems.push('src/lib/ui/ink-center.ts watches the DOM again: a span joins only from <Ink>, once React has mounted it')
  for (const file of tsxFiles()) {
    if (file.endsWith('/components/ui/ink.tsx')) continue
    const text = readFileSync(file, 'utf8')
    const m = text.match(/<span[^>]*\sdata-ink\b/)
    if (m) problems.push(`${rel(file)}:${lineAt(text, m.index)}: a hand-written <span data-ink>; use <Ink> (components/ui/ink.tsx), which joins the pass only once React has mounted it`)
  }
  if (!/\[data-ink\] \{ display: inline-block; \}/.test(read('src/app/globals.css'))) problems.push('src/app/globals.css lost the [data-ink] inline-block rule')
}

// ---------- icons drawn by hand ----------
const attrs = (s) => {
  const a = {}
  for (const m of s.matchAll(/([\w-]+)=(?:"([^"]*)"|\{([^{}]*)\})/g)) a[m[1]] = m[2] ?? (/^\s*-?[\d.]+\s*$/.test(m[3]) ? m[3].trim() : null)
  return a
}
const GEOMETRY = { path: ['d'], rect: ['x', 'y', 'width', 'height'], circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], line: ['x1', 'y1', 'x2', 'y2'], polyline: ['points'], polygon: ['points'] }
for (const file of tsxFiles()) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)) {
    const svg = attrs(m[1])
    const vb = (svg.viewBox ?? '').split(/[\s,]+/).map(Number)
    if (vb.length !== 4 || vb.some(Number.isNaN)) continue
    if (Object.keys(NOT_ICONS).some((c) => new RegExp(`\\b${c}\\b`).test(m[1]))) continue
    const shapes = []
    let fixed = true
    const stack = [svg]
    for (const t of m[2].matchAll(/<(\/?)(g|path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*?)(\/?)>/g)) {
      if (t[1]) {
        if (t[2] === 'g') stack.pop()
        continue
      }
      const a = attrs(t[3])
      if (t[2] === 'g') {
        if (!t[4]) stack.push(a)
        continue
      }
      if (GEOMETRY[t[2]].some((k) => a[k] === null || ((k === 'd' || k === 'points') && a[k] === undefined))) {
        fixed = false
        break
      }
      const from = [a, ...stack.slice().reverse()]
      const stroke = from.find((o) => o.stroke !== undefined)?.stroke
      const width = parseFloat(from.find((o) => o.strokeWidth !== undefined)?.strokeWidth ?? (stroke && stroke !== 'none' ? 1 : 0))
      shapes.push([t[2], a, stroke && stroke !== 'none' ? width : 0])
    }
    if (!fixed || !shapes.length) continue
    const b = inkBox(shapes)
    const mx = vb[0] + vb[2] / 2
    const my = vb[1] + vb[3] / 2
    const tol = (TOL * Math.max(vb[2], vb[3])) / 24
    if (Math.abs(b.cx - mx) >= tol || Math.abs(b.cy - my) >= tol)
      problems.push(`${rel(file)}:${lineAt(text, m.index)}: an icon drawn off its middle: its ink's middle is (${round(b.cx)}, ${round(b.cy)}), its viewBox's (${round(mx)}, ${round(my)}). Centre the viewBox on the ink (x ${round(b.cx - vb[2] / 2)}, y ${round(b.cy - vb[3] / 2)}), or name it in NOT_ICONS if it isn't an icon in a holder`)
  }
}
if (problems.length) {
  console.error(`Icons sit in the middle of what holds them (2026-10-28):\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
if (!process.argv.includes('--write')) console.log(`check-icon-centers: the ${used.size} Lucide icons LeadStart uses are centred (${rules.length} by icon-centers.css), and so are the ones drawn by hand`)
