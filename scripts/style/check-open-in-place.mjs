// A screen opens in its place (Daniel, 2026-10-21, cardinal rule: "a screen opens in its place, never starting somewhere
// and then jumping"), a port of Forge's scripts/check-open-in-place.mjs. Run by `npm run typecheck`. This fails:
// - A view brought to its end after the frame is drawn: an effect (useEffect) that sets a scroller's scrollTop from its
//   scrollHeight, directly or through a helper in the same file, shows where the view was first. Use useLayoutEffect,
//   which runs before the frame is drawn. (An observer's callback inside an effect is fine: it runs before the frame.)
// - A room that eases: a transition on a CSS variable (`transition: --x …`, or Tailwind's `transition-[--x]`) slides
//   whatever stands on that room and lays out everything under where it's set again every frame. Move things with
//   transform and opacity, or give each screen its own room so nothing has to move.
import { readFileSync } from 'node:fs'
import { codeFiles, cssFiles, isFn, lineAt, parse, rel, ts } from './lib.mjs'

const late = []
const eased = []
/** The nodes of a function's own body, not those of functions inside it (an observer's or a frame's callback). */
const own = (fn, cb) => {
  const visit = (n) => {
    if (n !== fn && isFn(n)) return
    cb(n)
    ts.forEachChild(n, visit)
  }
  visit(fn)
}
for (const file of codeFiles()) {
  const { text, sf } = parse(file)
  const toEnd = (n) =>
    (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'scrollTop' && n.right.getText(sf).includes('scrollHeight')) ||
    (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'scrollTo' && n.arguments.some((a) => a.getText(sf).includes('scrollHeight')))
  const helpers = new Set()
  const findHelpers = (n) => {
    const fn = ts.isVariableDeclaration(n) && n.initializer && isFn(n.initializer) ? n.initializer : ts.isFunctionDeclaration(n) ? n : undefined
    const name = ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) ? n.name.text : n.name?.text
    if (fn && name) {
      let hit = false
      own(fn, (x) => (hit ||= toEnd(x)))
      if (hit) helpers.add(name)
    }
    ts.forEachChild(n, findHelpers)
  }
  findHelpers(sf)
  const findEffects = (n) => {
    const callee = ts.isCallExpression(n) ? n.expression.getText(sf) : ''
    if ((callee === 'useEffect' || callee === 'React.useEffect') && n.arguments[0] && isFn(n.arguments[0])) {
      let hit = false
      own(n.arguments[0], (x) => (hit ||= toEnd(x) || (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && helpers.has(x.expression.text))))
      if (hit) late.push(`${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
    }
    ts.forEachChild(n, findEffects)
  }
  findEffects(sf)
  for (const m of text.matchAll(/\btransition-\[--[\w-]+/g)) eased.push(`${rel(file)}:${lineAt(text, m.index)}`)
}
for (const file of cssFiles()) {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  for (const m of text.matchAll(/(?:^|[;{\s])transition(?:-property)?\s*:([^;}]*)/g)) {
    if (/(?:^|[\s,])--[\w-]+/.test(m[1])) eased.push(`${rel(file)}:${lineAt(text, m.index)}`)
  }
}
if (late.length) console.error(`A view brought to its end after its frame is drawn, so it shows somewhere else first (2026-10-21: "a screen opens in its place"). Use useLayoutEffect, which runs before the frame:\n${late.map((m) => `  ${m}`).join('\n')}`)
if (eased.length) console.error(`A CSS variable that eases: what stands on it slides, and everything under it is laid out again every frame (2026-10-21). Move things with transform and opacity, or give each screen its own value:\n${eased.map((m) => `  ${m}`).join('\n')}`)
if (late.length || eased.length) process.exit(1)
console.log('check-open-in-place: no view brought to its end after the frame, no CSS variable that eases')
