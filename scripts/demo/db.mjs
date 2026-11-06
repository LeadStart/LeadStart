// The demo's own database (Daniel, 2026-11-06, on where the sample data lives: "it needs to be hosted on the actual demo
// itself, not in supabase.."). A Postgres held in the demo's own process (PGlite, Postgres built to WebAssembly, in
// memory), built fresh on every start: Supabase's base roles and auth schema, every file in supabase/migrations in
// order, then the made-up rows of sample-data.mjs. @supabase/lite answers the app's Supabase calls (the Data API and
// Auth) from it, so the app's code runs unchanged and nothing reaches the live project.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { App, getAuthSchemaSql, SUPABASE_AUTH_HELPERS_SQL } from '@supabase/lite'
import { createPgliteConnection } from '@supabase/lite/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { sampleData, SAMPLE_USERS } from './sample-data.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))

/** The demo's keys: made up, known to the demo only (the app reads them as its Supabase keys). */
export const DEMO_KEYS = {
  publishable: 'sb_publishable_leadstart_demo',
  secret: 'sb_secret_leadstart_demo',
  jwtSecret: 'leadstart-demo-jwt-secret-not-a-real-key-0001'
}

// What Supabase's own platform sets up before a project's migrations run: the API roles, the auth admin role the
// access-token hook is granted to, and the extensions schema.
const PLATFORM = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin noinherit; end if;
end $$;
create schema if not exists extensions;
grant usage on schema public, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`

/** Builds the database and the app that serves it; `say` hears each step. */
export async function bootDemoDb(say = () => {}) {
  const t0 = Date.now()
  const connection = await createPgliteConnection({ pgliteOptions: { extensions: { pg_trgm } } })
  const pg = connection.driver
  await pg.exec(PLATFORM)
  await pg.exec(getAuthSchemaSql())
  await pg.exec(SUPABASE_AUTH_HELPERS_SQL)
  await pg.exec('grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;')

  const dir = join(root, 'supabase', 'migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    try {
      await pg.exec(readFileSync(join(dir, f), 'utf8'))
    } catch (e) {
      throw new Error(`migration ${f} failed in the demo database: ${String(e?.message ?? e).split('\n')[0]}`)
    }
  }
  say(`${files.length} migrations applied in ${Date.now() - t0} ms`)

  const app = new App({
    connection,
    auth: {
      enabled: true,
      jwt_secret: DEMO_KEYS.jwtSecret,
      jwt_expiry: 7 * 24 * 3600,
      publishable_key: DEMO_KEYS.publishable,
      secret_key: DEMO_KEYS.secret
    }
  })

  const t1 = Date.now()
  await sampleData(pg)
  say(`sample data loaded in ${Date.now() - t1} ms`)
  return { app, pg, users: SAMPLE_USERS }
}
