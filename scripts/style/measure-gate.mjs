// The measured gate (Daniel: "Check it by measuring, never by eye"), a port of Forge's scripts/measure-gate.mjs for a
// Next.js app: the styling rules' page measures, run against a dev server on every screen at four sizes. `npm run
// measure` (the dev server up on --base, default http://localhost:3030, with main's .env.local so the dev auto-login
// works). It starts Playwright's chrome-headless-shell with a debugging port, logs in through /app/api/dev/login,
// visits every route (dynamic ids found from the list pages' links) at 1440, 1024, 390 and 375 wide, and evaluates in
// each, at rest and with every fold opened (and the drawer open on a phone):
// - the sideways check of "Bleed must be paid back": the page and every vertical scroller, scrollWidth === clientWidth;
// - stacked cards: no two sibling cards overlap or touch where a gap was designed;
// - every fold's gap payback: the gap above and below a fold, closed and open, equals its container's design gap;
// - scripts/style/measure-glows.js (a glow cut while its element is in view, a borrowed strip over something you can
//   press), at rest and with each scroller at its end;
// - scripts/style/measure-icon-centers.js (an icon's ink off its holder's middle);
// - scripts/style/measure-button-labels.js (a button's words off its middle).
// Anything found fails it, listed. Routes that redirect elsewhere (a client page under an admin login) are reported,
// not measured.
//
//   node scripts/style/measure-gate.mjs [--base http://localhost:3030] [--sizes 1440,1024,390,375] [--routes /admin,/admin/campaigns] [--json /tmp/leadstart-measure-gate.json] [--no-folds] [--no-drawer] [--probe file.js]
// --probe evaluates a script of your own in each screen instead of the measures and prints what it returns (a page measure
// while you work on one thing).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const flag = (name) => process.argv.includes(`--${name}`)
const say = (line) => console.log(`measure-gate: ${line}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const base = (arg('base') ?? 'http://localhost:3030').replace(/\/$/, '')
const CHROME = arg('chrome') ?? join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell')
if (!existsSync(CHROME)) {
  say(`refused: no chrome-headless-shell at ${CHROME} (pass --chrome)`)
  process.exit(1)
}
const HEIGHTS = { 1440: 900, 1024: 768, 390: 844, 375: 812 }
const sizes = (arg('sizes') ?? '1440,1024,390,375').split(',').map(Number)
const STATIC = [
  '/admin', '/admin/campaigns', '/admin/campaigns/new/native', '/admin/campaigns/new/linkedin', '/admin/clients', '/admin/contacts', '/admin/feedback', '/admin/inbox',
  '/admin/linkedin-tasks', '/admin/mailboxes', '/admin/planner', '/admin/prospecting', '/admin/prospects', '/admin/reports', '/admin/reports/preview',
  '/admin/settings', '/admin/settings/api', '/admin/settings/billing', '/admin/settings/buyer-experience', '/admin/settings/tags', '/admin/settings/tasks',
  '/admin/settings/team', '/admin/settings/tokens', '/admin/settings/workflows', '/admin/workflows', '/admin/workflows/onboarding',
  '/buyer', '/buyer/contacts', '/buyer/search', '/client', '/client/activity', '/client/feedback', '/client/inbox', '/client/reports', '/client/settings',
  '/login', '/signup', '/reset-password', '/update-password', '/accept-invite', '/billing/welcome'
]
/** Routes with an id, found from the links of the pages visited. */
const DYNAMIC = [
  /^\/app\/admin\/campaigns\/(?!new)[^/]+$/,
  /^\/app\/admin\/clients\/[^/]+$/,
  /^\/app\/admin\/clients\/[^/]+\/campaigns\/[^/]+$/,
  /^\/app\/admin\/inbox\/[^/]+$/,
  /^\/app\/client\/campaigns\/[^/]+$/,
  /^\/app\/client\/inbox\/[^/]+$/,
  /^\/app\/quote\/[^/]+$/
]
const routes = arg('routes') ? arg('routes').split(',') : [...STATIC]
const jsonOut = arg('json') ?? '/tmp/leadstart-measure-gate.json'

const MEASURES = ['measure-glows.js', 'measure-icon-centers.js', 'measure-button-labels.js'].map((f) => ({ name: f.replace(/^measure-|\.js$/g, ''), src: readFileSync(join(here, f), 'utf8') }))
const SIDEWAYS = `(() => {
  const bad = []
  const root = document.documentElement
  if (root.scrollWidth > root.clientWidth || document.body.scrollWidth > document.body.clientWidth) bad.push({ el: 'the page', scrollWidth: root.scrollWidth, clientWidth: root.clientWidth })
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (!/auto|scroll/.test(cs.overflowY) || /auto|scroll/.test(cs.overflowX)) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (el.scrollWidth > el.clientWidth + 1) bad.push({ el: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })
  }
  return JSON.stringify(bad)
})()`
// Stacked cards: siblings that overlap, or touch where their container designed a gap.
const STACKED = `(() => {
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')
  const shown = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false } return true }
  const isCard = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return r.height >= 40 && r.width >= 80 && cs.position !== 'absolute' && cs.position !== 'fixed' && cs.boxShadow !== 'none' && !/^rgba\\(0, 0, 0, 0\\) 0px 0px 0px 0px$/.test(cs.boxShadow) }
  const bad = []
  for (const parent of document.querySelectorAll('body *')) {
    const kids = [...parent.children].filter((k) => shown(k) && isCard(k))
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect()
      if (b.top < a.bottom - 1 && b.left < a.right - 1 && a.left < b.right - 1 && a.top < b.top) {
        if (b.top < a.bottom - 0.5) bad.push({ a: name(kids[i - 1]), b: name(kids[i]), gap: +(b.top - a.bottom).toFixed(2), what: 'overlap' })
        continue
      }
      if (!(b.top >= a.bottom - 1)) continue
      const gap = b.top - a.bottom
      const pcs = getComputedStyle(parent)
      const designed = Math.max(parseFloat(pcs.rowGap) || 0, parseFloat(getComputedStyle(kids[i - 1]).marginBottom) || 0, parseFloat(getComputedStyle(kids[i]).marginTop) || 0)
      if (gap < 0.5 && designed > 0) bad.push({ a: name(kids[i - 1]), b: name(kids[i]), gap: +gap.toFixed(2), designed, what: 'touching' })
    }
  }
  return JSON.stringify(bad)
})()`
// Every fold's gap payback: closed, the gap from its previous sibling to its next equals the design gap; open, the gap
// above its content and below it do.
const FOLDS = `(() => {
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')
  const out = []
  for (const fold of document.querySelectorAll('.fold')) {
    const parent = fold.parentElement
    if (!parent) continue
    const sib = (dir) => { let e = fold; while ((e = dir < 0 ? e.previousElementSibling : e.nextElementSibling)) { const r = e.getBoundingClientRect(); if (r.height > 0 && getComputedStyle(e).position !== 'absolute') return e } return null }
    const prev = sib(-1), next = sib(1)
    const pcs = getComputedStyle(parent)
    const design = parseFloat(pcs.rowGap) || (prev ? parseFloat(getComputedStyle(prev).marginBottom) || 0 : 0) || (next ? parseFloat(getComputedStyle(next).marginTop) || 0 : 0)
    const layer = fold.querySelector(':scope > .fold-in')
    const r = fold.getBoundingClientRect()
    const one = { fold: name(fold), in: name(parent), open: !!layer, design, height: +r.height.toFixed(2) }
    if (!layer) {
      if (prev && next) one.around = +(next.getBoundingClientRect().top - prev.getBoundingClientRect().bottom).toFixed(2)
    } else {
      const lr = layer.getBoundingClientRect(), lcs = getComputedStyle(layer)
      const top = lr.top + (parseFloat(lcs.paddingTop) || 0), bottom = lr.bottom - (parseFloat(lcs.paddingBottom) || 0)
      if (prev) one.above = +(top - prev.getBoundingClientRect().bottom).toFixed(2)
      if (next) one.below = +(next.getBoundingClientRect().top - bottom).toFixed(2)
    }
    const off = ['around', 'above', 'below'].filter((k) => one[k] !== undefined && Math.abs(one[k] - design) > 1)
    if (off.length) one.off = off
    out.push(one)
  }
  return JSON.stringify(out)
})()`
const SCROLLERS = `(() => {
  const out = []
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (!/auto|scroll/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 1 || !el.getBoundingClientRect().height) continue
    el.setAttribute('data-gate-scroller', String(out.length))
    out.push(el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''))
  }
  return JSON.stringify(out)
})()`
const OPEN_FOLDS = `(() => {
  let n = 0
  for (const el of document.querySelectorAll('[aria-expanded="false"]:not([aria-haspopup])')) {
    if (el.closest('.app-rail, header')) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    el.click()
    n++
  }
  return n
})()`
// The phone's drawer opens from the account menu's "All sections" (the topbar's DropdownMenu): the trigger's box, then
// the item's, each tapped for real through CDP (Base UI opens its menu on a pointer, not a synthetic click).
const BOX = (sel, words) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.getBoundingClientRect().width && (!${JSON.stringify(words ?? '')} || new RegExp(${JSON.stringify(words ?? '')}, 'i').test(e.textContent || ''))); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`
const LINKS = `JSON.stringify([...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => h && h.startsWith('/app/')).map((h) => h.split('?')[0]))`

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

// ---------- the browser ----------
const port = await freePort()
const tmp = mkdtempSync(join(tmpdir(), 'leadstart-measure-gate-'))
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })
let chromeOut = ''
chrome.stdout.on('data', (d) => (chromeOut += d))
chrome.stderr.on('data', (d) => (chromeOut += d))
let exited = false
chrome.on('exit', () => (exited = true))
const stop = async () => {
  if (exited) return
  chrome.kill('SIGTERM')
  for (let i = 0; i < 30 && !exited; i++) await sleep(100)
  if (!exited) chrome.kill('SIGKILL')
}
process.on('exit', () => {
  if (!exited) chrome.kill('SIGKILL')
  rmSync(tmp, { recursive: true, force: true })
})
let page
for (let i = 0; i < 40 && !page; i++) {
  await sleep(250)
  if (exited) break
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    page = targets.find((t) => t.type === 'page')
  } catch {
    /* not up yet */
  }
}
if (!page) {
  say(`the browser never opened a page:\n${chromeOut.split('\n').slice(-8).join('\n')}`)
  await stop()
  process.exit(1)
}

// ---------- CDP ----------
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.onopen = r
  ws.onerror = j
})
let n = 0
const pending = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  }
}
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++n
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })
const ev = async (expression) => {
  const d = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description ?? JSON.stringify(d.result.exceptionDetails))
  return d.result?.result?.value
}
await send('Page.enable')
await send('Runtime.enable')
const size = async (w) => {
  const phone = w < 1024
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: HEIGHTS[w] ?? 900, deviceScaleFactor: 2, mobile: phone })
  await send('Emulation.setTouchEmulationEnabled', { enabled: phone, maxTouchPoints: 5 })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: phone ? 'none' : 'hover' }, { name: 'pointer', value: phone ? 'coarse' : 'fine' }] })
}
const tap = async (x, y, phone) => {
  if (phone) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
}
const openDrawer = async (phone) => {
  const t = JSON.parse((await ev(BOX('header button[data-tucked]'))) ?? 'null')
  if (!t) return false
  await tap(t.x, t.y, phone)
  await sleep(450)
  const item = JSON.parse((await ev(BOX('[role="menuitem"]', 'All sections'))) ?? 'null')
  if (!item) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    return false
  }
  await tap(item.x, item.y, phone)
  await sleep(700)
  return await ev(`!!document.querySelector('.app-rail.is-open')`)
}
const goto = async (url) => {
  await send('Page.navigate', { url })
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    try {
      if (await ev(`document.readyState === 'complete'`)) break
    } catch {
      /* mid-navigation */
    }
  }
}
/** Waits until the page's element count has held still for 600ms and no loading veil is up, 10 seconds at most. */
const settle = async () => {
  let last = -1
  for (let i = 0; i < 16; i++) {
    await sleep(600)
    const now = await ev(`document.querySelectorAll('*').length + (document.querySelector('.ls-veil[aria-busy="true"], [data-loading="true"]') ? 100000 : 0)`)
    if (now === last && now < 100000) return
    last = now
  }
}

// ---------- log in ----------
await size(1440)
// The dev login makes a magic link and verifies it at once; another login for the same user in the same moment
// (a second browser, another gate) replaces the token first, and this one reads "Email link is invalid or has
// expired". Three tries, a moment apart, ride that out.
let landed = ''
for (let attempt = 1; attempt <= 3; attempt++) {
  await goto(`${base}/app/api/dev/login`)
  await settle()
  landed = await ev('location.pathname')
  if (/^\/app\/(admin|client|buyer)/.test(landed)) break
  if (attempt < 3) await new Promise(r => setTimeout(r, 1500))
}
if (!/^\/app\/(admin|client|buyer)/.test(landed)) {
  say(`the dev auto-login didn't land in the app (at ${landed}): is the dev server on ${base} running with DEV_AUTOLOGIN_EMAIL?\n${(await ev('document.body.innerText')).slice(0, 900)}`)
  await stop()
  process.exit(1)
}
say(`logged in, at ${landed}; ${routes.length} routes × ${sizes.join('/')} wide`)

// ---------- the screens ----------
const results = []
const problems = []
const found = new Set()
let viewing = null
const seen = new Set(routes)
const note = (r, state, what, list) => {
  for (const item of list) problems.push(`${r.route} @${r.width}${state ? ` · ${state}` : ''} · ${what}: ${typeof item === 'string' ? item : JSON.stringify(item).slice(0, 900)}`)
}
const measureAll = async (r, state) => {
  const out = {}
  out.sideways = JSON.parse(await ev(SIDEWAYS))
  note(r, state, 'sideways scroll', out.sideways.map((b) => `${b.el} is ${b.scrollWidth}px wide in a box of ${b.clientWidth}px`))
  out.stacked = JSON.parse(await ev(STACKED))
  note(r, state, 'stacked cards', out.stacked)
  out.folds = JSON.parse(await ev(FOLDS))
  note(r, state, "a fold's gap off its design gap", out.folds.filter((f) => f.off))
  for (const m of MEASURES) {
    const o = JSON.parse(await ev(m.src))
    out[m.name] = o
    if (m.name === 'glows') {
      note(r, state, 'glow cut', (o.capped ?? []).map((c) => `${c.glow} (${Object.entries(c.cut).map(([s, px]) => `${s} ${px}px`).join(', ')}) by ${c.by}`))
      note(r, state, "a glow's borrowed strip takes presses", o.strips ?? [])
    } else note(r, state, m.name, o.list ?? [])
  }
  const scrollers = JSON.parse(await ev(SCROLLERS))
  out.atEnd = []
  for (let i = 0; i < scrollers.length; i++) {
    await ev(`(() => { const el = document.querySelector('[data-gate-scroller="${i}"]'); el.scrollTop = el.scrollHeight })()`)
    await sleep(300)
    const o = JSON.parse(await ev(MEASURES[0].src))
    out.atEnd.push({ scroller: scrollers[i], capped: o.capped ?? [], strips: o.strips ?? [] })
    note(r, `${state ? state + ' · ' : ''}at the end of ${scrollers[i]}`, 'glow cut', (o.capped ?? []).map((c) => `${c.glow} (${Object.entries(c.cut).map(([s, px]) => `${s} ${px}px`).join(', ')}) by ${c.by}`))
    note(r, `${state ? state + ' · ' : ''}at the end of ${scrollers[i]}`, "a glow's borrowed strip takes presses", o.strips ?? [])
    await ev(`(() => { const el = document.querySelector('[data-gate-scroller="${i}"]'); el.scrollTop = 0; el.removeAttribute('data-gate-scroller') })()`)
  }
  return out
}
const counts = (o) => `sideways ${o.sideways.length}, stacked ${o.stacked.length}, folds ${o.folds.length}/${o.folds.filter((f) => f.off).length} off, glows ${o.glows?.glows ?? '?'}/${o.glows?.capped?.length ?? '?'} cut (${o.atEnd.length} at end: ${o.atEnd.reduce((s, e) => s + e.capped.length, 0)}), icons ${o['icon-centers']?.measured ?? '?'}/${o['icon-centers']?.off ?? '?'} off, buttons ${o['button-labels']?.measured ?? '?'}/${o['button-labels']?.off ?? '?'} off`

for (let qi = 0; qi < routes.length; qi++) {
  const route = routes[qi]
  for (const width of sizes) {
    const r = { route, width }
    try {
      await size(width)
      // A client page is seen as the first client found (View as), an admin page as the admin.
      const wantClient = /^\/client(\/|$)/.test(route)
      if (wantClient && !viewing) {
        const id = [...seen].map((p) => p.match(/^\/admin\/clients\/([^/]+)$/)?.[1]).find(Boolean)
        if (id) {
          await ev(`fetch('/app/api/admin/view-as', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: ${JSON.stringify(id)} }) }).then((r) => r.status)`)
          viewing = id
        }
      } else if (!wantClient && viewing) {
        await ev(`fetch('/app/api/admin/view-as', { method: 'DELETE' }).then((r) => r.status)`)
        viewing = null
      }
      await goto(`${base}/app${route}`)
      await settle()
      const at = await ev('location.pathname')
      if (at !== `/app${route}` && at !== `/app${route}/`) {
        r.redirected = at
        say(`${route} @${width}: redirected to ${at} (not measured)`)
        results.push(r)
        continue
      }
      // Routes with an id, from this page's links.
      for (const href of JSON.parse(await ev(LINKS))) {
        for (const p of DYNAMIC) {
          if (p.test(href) && !found.has(String(p))) {
            found.add(String(p))
            const next = href.replace(/^\/app/, '')
            if (!seen.has(next)) {
              seen.add(next)
              routes.push(next)
            }
          }
        }
      }
      if (arg('probe')) {
        r.probe = await ev(readFileSync(arg('probe'), 'utf8'))
        say(`${route} @${width} probe: ${typeof r.probe === 'string' ? r.probe : JSON.stringify(r.probe)}`)
        results.push(r)
        continue
      }
      r.rest = await measureAll(r, '')
      say(`${route} @${width}: ${counts(r.rest)}`)
      if (!flag('no-folds')) {
        const opened = await ev(OPEN_FOLDS)
        if (opened) {
          await sleep(500)
          r.foldsOpen = await measureAll(r, `${opened} folds open`)
          say(`${route} @${width} · ${opened} folds open: ${counts(r.foldsOpen)}`)
        }
      }
      if (width < 1024 && !flag('no-drawer')) {
        if (await openDrawer(true)) {
          await sleep(700)
          r.drawer = await measureAll(r, 'drawer open')
          say(`${route} @${width} · drawer open: ${counts(r.drawer)}`)
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
          await sleep(500)
        }
      }
    } catch (e) {
      r.error = String(e.message).slice(0, 900)
      problems.push(`${route} @${width} · the measure couldn't run: ${r.error}`)
      say(`${route} @${width}: ERROR ${r.error}`)
    }
    results.push(r)
  }
}
ws.close()
await stop()
try {
  writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), base, sizes, results, problems }, null, 1))
} catch {
  /* the summary above stands */
}
const redirected = results.filter((r) => r.redirected)
if (redirected.length) say(`${redirected.length} screen loads redirected elsewhere and weren't measured: ${[...new Set(redirected.map((r) => `${r.route} → ${r.redirected}`))].join('; ')}`)
if (problems.length) {
  say(`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} (the styling rules' measures must come back empty):`)
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
say(`green: ${results.filter((r) => r.rest).length} screens measured, every measure empty (${jsonOut})`)
