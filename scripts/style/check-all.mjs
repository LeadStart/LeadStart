// The styling checks, run by `npm run typecheck` (and `npm run check:style`): each scripts/style/check-*.mjs holds one of
// the styling rules in the code (Daniel: "Must be algorithmic in reference."). Every check runs; the first failing
// one's words are the ones to act on; all are listed.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dir = fileURLToPath(new URL('.', import.meta.url))
const checks = readdirSync(dir).filter((f) => /^check-(?!all\.mjs$)[\w-]+\.mjs$/.test(f)).sort()
let failed = 0
for (const f of checks) {
  const r = spawnSync(process.execPath, [join(dir, f)], { encoding: 'utf8' })
  if (r.stdout.trim()) console.log(r.stdout.trim())
  if (r.status !== 0) {
    failed++
    console.error(`✗ ${f}\n${(r.stderr || r.stdout).trim()}`)
  }
}
if (failed) {
  console.error(`check-styling: ${failed} of ${checks.length} checks failed`)
  process.exit(1)
}
console.log(`check-styling: ${checks.length} checks green`)
