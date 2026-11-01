// Shared by the styling checks (scripts/style/check-*.mjs, run by `npm run typecheck`): the files under src/, a
// TypeScript parse of each, the classes a JSX tag can carry (Tailwind utilities and the stylesheet's own classes),
// and the stylesheet's rules. The checks are ports of Forge's (~/Claude/Forge/scripts/check-*.mjs) for a Next.js app
// styled with Tailwind: where Forge reads a class's layout from its stylesheet, these read the utilities on the tag.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export { ts }
export const repo = fileURLToPath(new URL('../..', import.meta.url))
export const src = join(repo, 'src')
export const rel = (p) => relative(repo, p)
export const read = (p) => readFileSync(join(repo, p), 'utf8')

export function walk(dir, ok = () => true, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, ok, out)
    else if (ok(p)) out.push(p)
  }
  return out
}
export const tsxFiles = () => walk(src, (p) => p.endsWith('.tsx'))
export const codeFiles = () => walk(src, (p) => /\.tsx?$/.test(p))
export const cssFiles = () => walk(src, (p) => p.endsWith('.css'))

export function parse(file) {
  const text = readFileSync(file, 'utf8')
  return { file, text, sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) }
}
export const lineAt = (text, index) => text.slice(0, index).split('\n').length
export const at = (file, sf, node) => `${rel(file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
export const tagOf = (node) => (ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined)
export const tagName = (tag, sf) => tag.tagName.getText(sf)
export const attr = (tag, name) => tag.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === name)
export const attrNames = (tag) => tag.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText())
export const spreads = (tag, sf) => tag.attributes.properties.filter(ts.isJsxSpreadAttribute).map((a) => a.expression.getText(sf))
export const isFn = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
export const valueOf = (a) => (a?.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined)

/** Every bit of fixed text in a JSX attribute's value (a class list however it's put together: a string, a template, cn(…)). */
export const textOf = (init) => {
  if (!init) return ''
  if (ts.isStringLiteral(init)) return init.text
  const parts = []
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text)
    else if (ts.isTemplateExpression(n)) {
      parts.push(n.head.text)
      n.templateSpans.forEach((s) => (visit(s.expression), parts.push(s.literal.text)))
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(init)
  return parts.join(' ')
}
/** The classes a tag can carry: every word in its className's strings (a conditional's both sides), and a CSS module's
 *  `styles.name` (flow.module.css), by the module's identifier(s) in the file. */
export const classesOf = (tag, sf, moduleIdents = new Set()) => {
  const a = attr(tag, 'className')
  const init = a?.initializer
  const words = textOf(init).split(/\s+/).filter(Boolean)
  if (init && !ts.isStringLiteral(init) && moduleIdents.size) {
    const visit = (n) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && moduleIdents.has(n.expression.text)) words.push(n.name.text)
      ts.forEachChild(n, visit)
    }
    visit(init)
  }
  return words
}
/** The identifiers a file imports a CSS module as. */
export const moduleIdentsOf = (text) => new Set([...text.matchAll(/import\s+(\w+)\s+from\s+["'][^"']+\.module\.css["']/g)].map((m) => m[1]))
/** The component a node is drawn in: the nearest function with a capitalised name, [name, fn]. */
export const componentOf = (node) => {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name && /^[A-Z]/.test(n.name.text)) return [n.name.text, n]
    if (isFn(n) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) && /^[A-Z]/.test(n.parent.name.text)) return [n.parent.name.text, n]
  }
  return [undefined, undefined]
}
/** The state an expression reads: its names, less one-letter ones and `id`, `props` (what every row has). */
export const names = (expr) => {
  const out = new Set()
  const visit = (n) => {
    if (ts.isIdentifier(n) && n.text.length > 1 && n.text !== 'id' && n.text !== 'props') out.add(n.text)
    ts.forEachChild(n, visit)
  }
  if (expr) visit(expr)
  return out
}
/** A Tailwind class without its variants (`sm:hover:flex` → `flex`; a bracket's or parenthesis's colon kept). */
export function utility(c) {
  let depth = 0
  let from = 0
  for (let i = 0; i < c.length; i++) {
    if (c[i] === '[' || c[i] === '(') depth++
    else if (c[i] === ']' || c[i] === ')') depth--
    else if (c[i] === ':' && depth === 0) from = i + 1
  }
  return c.slice(from)
}
export const variantOf = (c) => c.slice(0, c.length - utility(c).length).replace(/:$/, '')

/** Every rule of a stylesheet (selectors, its own declarations, its line), @media, @layer and @supports blocks
 *  included, and nested rules (`&:hover { … }`) as rules of their own. Comments are blanked, lines kept. */
export function rules(text) {
  const masked = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const out = []
  const stack = []
  let buf = ''
  let bufAt = 0
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]
    if (c === '{') {
      const head = buf.trim()
      stack.push({ head, decls: '', at: bufAt + buf.search(/\S/) })
      buf = ''
      bufAt = i + 1
    } else if (c === '}') {
      const top = stack.pop() ?? { head: '', decls: '', at: bufAt }
      top.decls += buf
      if (top.head && !top.head.startsWith('@')) out.push({ sel: top.head, body: top.decls, line: lineAt(masked, top.at) })
      buf = ''
      bufAt = i + 1
    } else if (c === ';') {
      if (stack.length) stack[stack.length - 1].decls += buf + ';'
      buf = ''
      bufAt = i + 1
    } else buf += c
  }
  return out
}
/** A selector list split at its own commas (not those inside `:is(…)`). */
export const selectors = (list) => {
  const out = []
  let depth = 0
  let from = 0
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++
    else if (list[i] === ')') depth--
    else if (list[i] === ',' && depth === 0) out.push(list.slice(from, i)), (from = i + 1)
  }
  return [...out, list.slice(from)].map((s) => s.trim()).filter(Boolean)
}
/** The classes of a selector's subject: its last compound, past the last combinator (each of an `:is(…)` list's). */
export const subjectClasses = (sel) => {
  const flat = sel.replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)/g, '').replace(/\[[^\]]*\]/g, '')
  let depth = 0
  let from = 0
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === '(') depth++
    else if (flat[i] === ')') depth--
    else if (depth === 0 && /[\s>+~]/.test(flat[i])) from = i + 1
  }
  return [...flat.slice(from).matchAll(/\.([\w-]+)/g)].map((m) => m[1])
}
export const declsOf = (body) => [...body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()])
/** The utilities a rule applies (`@apply flex items-center;`). */
export const appliedOf = (body) => [...body.matchAll(/@apply\s+([^;]+)/g)].flatMap((m) => m[1].trim().split(/\s+/))
/** Every stylesheet under src/, parsed once. */
export const sheets = () => cssFiles().map((file) => ({ file, text: readFileSync(file, 'utf8'), rules: rules(readFileSync(file, 'utf8')) }))
export const styles = () => cssFiles().map((f) => readFileSync(f, 'utf8')).join('\n')
export const fail = (title, items) => {
  console.error(`${title}\n${items.map((m) => `  ${m}`).join('\n')}`)
}
