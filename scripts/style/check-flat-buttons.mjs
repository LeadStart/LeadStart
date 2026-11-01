// Buttons are flat (Forge's take B "Diagonal sheen", carried into LeadStart by task #228), a port of Forge's
// scripts/check-flat-buttons.mjs. Run by `npm run typecheck`. This fails a change that brings the dome back:
// - The shared fills: every `--tex-brand`, `--tex-white`, `--tex-ink` and `--tex-danger` in a stylesheet is a
//   `linear-gradient(140deg, …)`; one that inherits or names another token passes, since that one is checked where it's set.
// - A dome drawn by hand: a top-centre radial (`radial-gradient(130% 120% at 50% 0%, …)`) on an opaque fill, in a
//   stylesheet or in code. Glass keeps its look (Daniel, 2026-10-21: "Anything glass or frost should not be touched."):
//   a radial whose colours are all see-through (rgba under 1: the phone tab bar's pill) passes.
import { readFileSync } from 'node:fs'
import { codeFiles, cssFiles, lineAt, rel } from './lib.mjs'

const args = (text, open) => {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}
const seeThrough = (inner) => {
  const body = inner.replace(/^\s*[\d.]+%\s+[\d.]+%\s+at\s+[^,]+,/, '')
  const colours = [...body.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|var\([^)]*\)|color-mix\(|\b(?:white|black)\b/gi)].map((m) => m[0])
  if (!colours.length) return false
  return colours.every((c) => {
    const a = c.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i) ?? c.match(/^rgba?\([^/]*\/\s*([\d.]+)\s*\)$/i)
    return !!a && parseFloat(a[1]) < 1
  })
}
const tokens = []
const domes = []
for (const file of [...cssFiles(), ...codeFiles()]) {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  if (file.endsWith('.css'))
    for (const m of text.matchAll(/--tex-(?:brand|white|ink|danger)\s*:\s*([^;}]*)/g))
      if (!/^(?:linear-gradient\(\s*140deg\b|inherit$|var\(--tex-)/.test(m[1].trim())) tokens.push(`${rel(file)}:${lineAt(text, m.index)}  ${m[0].trim()}`)
  for (const m of text.matchAll(/radial-gradient\(\s*130%\s+120%\s+at\s+50%\s+0%/g)) if (!seeThrough(args(text, m.index + m[0].indexOf('(')))) domes.push(`${rel(file)}:${lineAt(text, m.index)}`)
}
if (tokens.length) console.error(`A shared fill that isn't flat: --tex-* is a linear-gradient(140deg, …):\n${tokens.map((m) => `  ${m}`).join('\n')}`)
if (domes.length) console.error(`A dome on an opaque fill. Use a gentle linear-gradient(140deg, lighter, deeper) with no shadow, or var(--tex-brand), var(--tex-white) or var(--tex-ink); only glass (all see-through colours) keeps a radial:\n${domes.map((m) => `  ${m}`).join('\n')}`)
if (tokens.length || domes.length) process.exit(1)
console.log('check-flat-buttons: the shared fills are flat 140° gradients, and no opaque dome is drawn by hand')
