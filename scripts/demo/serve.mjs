// The sample-data demo that Forge's styling check measures (`.claude/styling.json` names it; `npm run demo`, the
// `leadstart-demo` config in .claude/launch.json). Daniel, 2026-11-06, on where its data lives: "it needs to be hosted
// on the actual demo itself, not in supabase..".
//
// One address serves everything, because Forge's measuring browser refuses any request that isn't to the demo:
// - /auth/v1, /rest/v1, /storage/v1: the app's Supabase calls, answered by @supabase/lite from the demo's own database
//   (scripts/demo/db.mjs: a Postgres in this process, built fresh from supabase/migrations and sample-data.mjs);
// - everything else: the app itself, `next dev` on a private port, its Supabase address pointed back here.
// Each page opens signed in as the sample person who'd see it (an owner on /admin, a client on /client, a buyer on
// /buyer; nobody on the sign-in pages), so a fresh browser lands on the page itself, never the login.
//
// No live key reaches it: Next is given the demo's own made-up keys, and every variable a .env file in the folder
// names is blanked, so even run in the main checkout it never reads main's .env.local.
//
//   node scripts/demo/serve.mjs [--port 3040]
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as netServer, connect } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServerClient } from '@supabase/ssr'
import { bootDemoDb, DEMO_KEYS } from './db.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const port = Number(arg('port') ?? process.env.PORT ?? 3040)
const say = (line) => console.log(`demo: ${line}`)

const freePort = () =>
  new Promise((done, fail) => {
    const s = netServer()
    s.unref()
    s.on('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => done(p))
    })
  })

// 1. The database and the Supabase stand-in that serves it.
const { app, users } = await bootDemoDb(say)
const supabaseUrl = `http://localhost:${port}`
const SUPABASE_PATHS = /^\/(auth|rest|storage|functions)\/v1(\/|$)/

// 2. The app: next dev on a private port, every .env value blanked, the demo's keys in their place.
const nextPort = await freePort()
const env = { ...process.env }
delete env.PORT
for (const f of readdirSync(root).filter((n) => /^\.env(\..+)?$/.test(n) && n !== '.env.example')) {
  for (const line of readFileSync(join(root, f), 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m) env[m[1]] = ''
  }
}
Object.assign(env, {
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: DEMO_KEYS.publishable,
  SUPABASE_SERVICE_ROLE_KEY: DEMO_KEYS.secret,
  NEXT_PUBLIC_APP_URL: supabaseUrl,
  NEXT_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
  LITE_TELEMETRY: '0'
})
const next = spawn(process.execPath, [join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', String(nextPort), '-H', '127.0.0.1'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
// Next's own lines are passed on without its address: Forge reads the first local address the demo prints as the one
// to measure, and that must be this server's.
const relay = (b) => {
  const text = b.toString('utf8').replace(/https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+/g, '(next)')
  process.stdout.write(text.replace(/^(?=.)/gm, 'next: '))
}
next.stdout.on('data', relay)
next.stderr.on('data', relay)
next.on('exit', (code) => {
  say(`next stopped (${code})`)
  process.exit(code ?? 1)
})
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => (next.kill('SIGTERM'), process.exit(0)))

// 3. Supabase's access-token hook (migration 00009) puts the user's role and organization in the token's app_metadata,
// and the app's row-level security reads them there. @supabase/lite leaves app_metadata out of its tokens, so each
// token it issues is signed again here, with the demo's own secret, carrying them.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function withClaims(session) {
  if (!session?.access_token || !session.user) return session
  const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString('utf8'))
  claims.app_metadata = session.user.app_metadata ?? {}
  claims.user_metadata = session.user.user_metadata ?? {}
  const signed = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`
  return { ...session, access_token: `${signed}.${createHmac('sha256', DEMO_KEYS.jwtSecret).update(signed).digest('base64url')}` }
}
async function supabaseFetch(input, init) {
  const req = input instanceof Request && !init ? input : new Request(input, init)
  const r = await app.fetch(req, { peerAddress: null })
  if (!/\/auth\/v1\/(token|verify)/.test(new URL(req.url).pathname) || !r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return r
  const headers = new Headers(r.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify(withClaims(await r.json())), { status: r.status, headers })
}

// 4. The sample people's sessions, as the app's own cookies (written by @supabase/ssr, so they read back the same).
const sessions = new Map()
async function sessionCookies(who) {
  const had = sessions.get(who)
  if (had && had.until > Date.now()) return had.cookies
  const user = users[who]
  const jar = []
  const client = createServerClient(supabaseUrl, DEMO_KEYS.publishable, {
    cookies: { getAll: () => [], setAll: (list) => jar.push(...list) },
    global: { fetch: supabaseFetch }
  })
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password })
  if (error) throw new Error(`the sample ${who} couldn't sign in: ${error.message}`)
  sessions.set(who, { cookies: jar, until: Date.now() + 24 * 3600_000 })
  return jar
}

/** Who a page is seen as: a sample person, nobody (the sign-in pages), or whoever the browser already is. */
function seenAs(path) {
  if (!path.startsWith('/app')) return 'keep'
  const p = path.slice(4) || '/'
  if (/^\/(_next|api)\//.test(p) || /\.[a-z0-9]+$/i.test(p)) return 'keep'
  if (/^\/(login|signup|reset-password|update-password|accept-invite|auth)(\/|$)/.test(p)) return 'nobody'
  if (/^\/(quote|billing\/welcome)(\/|$)/.test(p)) return 'keep'
  if (/^\/client(\/|$)/.test(p)) return 'client'
  if (/^\/buyer(\/|$)/.test(p)) return 'buyer'
  return 'owner'
}

const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf('=')
        return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]
      })
  )
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`

async function toSupabase(req, res) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((done) => {
    const parts = []
    req.on('data', (c) => parts.push(c))
    req.on('end', () => done(Buffer.concat(parts)))
  })
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  const r = await supabaseFetch(new Request(`${supabaseUrl}${req.url}`, { method: req.method, headers, body }))
  const out = {}
  r.headers.forEach((v, k) => {
    if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') out[k] = v
  })
  const buf = Buffer.from(await r.arrayBuffer())
  res.writeHead(r.status, { ...out, 'content-length': buf.length })
  res.end(buf)
}

async function toNext(req, res) {
  const url = new URL(req.url, supabaseUrl)
  const who = seenAs(url.pathname)
  const jar = parseCookies(req.headers.cookie)
  const extra = []
  if (who !== 'keep') {
    const signedIn = Object.keys(jar).some((k) => k.startsWith('sb-'))
    if (who === 'nobody' ? signedIn : jar['demo-as'] !== who) {
      for (const k of Object.keys(jar)) {
        if (!k.startsWith('sb-') && k !== 'demo-as') continue
        delete jar[k]
        extra.push(setCookie(k, '', 0))
      }
      if (who !== 'nobody') {
        for (const c of await sessionCookies(who)) {
          jar[c.name] = c.value
          extra.push(setCookie(c.name, c.value, 7 * 24 * 3600))
        }
        jar['demo-as'] = who
        extra.push(setCookie('demo-as', who, 7 * 24 * 3600))
      }
      req.headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
    }
  }
  const up = httpRequest({ host: '127.0.0.1', port: nextPort, method: req.method, path: req.url, headers: { ...req.headers, host: `localhost:${port}` } }, (r) => {
    const headers = { ...r.headers }
    if (extra.length) headers['set-cookie'] = [...extra, ...[].concat(headers['set-cookie'] ?? [])]
    res.writeHead(r.statusCode ?? 502, headers)
    r.pipe(res)
  })
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`demo: the app isn't answering (${e.message})`)
  })
  req.pipe(up)
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  const go = SUPABASE_PATHS.test(path) ? toSupabase(req, res) : toNext(req, res)
  go.catch((e) => {
    say(`${req.method} ${req.url}: ${e.message}`)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(e.message))
  })
})
// The dev server's live reload (a websocket) passes straight through.
server.on('upgrade', (req, socket, head) => {
  const up = connect(nextPort, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
    if (head?.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  })
  up.on('error', () => socket.destroy())
  socket.on('error', () => up.destroy())
})

// 5. Open the door only once the app answers, so the first page Forge asks for is served.
const until = Date.now() + 80_000
for (;;) {
  const ok = await fetch(`http://127.0.0.1:${nextPort}/app/login`, { redirect: 'manual' }).then((r) => r.status < 500, () => false)
  if (ok) break
  if (Date.now() > until) {
    say("next didn't answer within 80 seconds")
    next.kill('SIGTERM')
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 500))
}
server.listen(port, () => say(`ready on http://localhost:${port}/app/admin`))
