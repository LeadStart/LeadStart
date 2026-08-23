// Supabase health & latency probe (READ-ONLY).
//
//   node scripts/diagnostics/supabase-health.mjs
//
// Reads .env.local for NEXT_PUBLIC_SUPABASE_URL + SUPABASE_ACCESS_TOKEN and
// prints: project region/plan/status, per-service health, a live REST latency
// sample, and the last hour of API-gateway latency/error stats. Never prints
// secrets (only key lengths, if anything). Nothing here writes or changes state.
//
// Use it before/after a restart or compute upgrade to confirm recovery, or any
// time the app feels slow, to tell "the DB is the bottleneck" apart from "the
// app/front-end is the bottleneck."

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "../../.env.local");

function loadEnv(path) {
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`Could not read ${path}. Run from the repo root.`);
    process.exit(1);
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return env;
}

const env = loadEnv(ENV_PATH);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const token = env.SUPABASE_ACCESS_TOKEN;
if (!url) {
  console.error("NEXT_PUBLIC_SUPABASE_URL missing from .env.local");
  process.exit(1);
}
const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
const mgmt = token ? { Authorization: `Bearer ${token}` } : null;

async function mgmtGet(path, timeout = 30000) {
  if (!mgmt) return { skipped: true };
  try {
    const r = await fetch(`https://api.supabase.com${path}`, {
      headers: mgmt,
      signal: AbortSignal.timeout(timeout),
    });
    const t = await r.text();
    let j = null;
    try {
      j = JSON.parse(t);
    } catch {}
    return { status: r.status, j, t };
  } catch (e) {
    return { error: e.message };
  }
}

console.log(`\nSupabase health — project ${ref} — ${new Date().toISOString()}\n`);

// 1) Project + plan + region
const proj = await mgmtGet(`/v1/projects/${ref}`);
if (proj.j) {
  console.log(`  status:  ${proj.j.status}`);
  console.log(`  region:  ${proj.j.region}`);
} else if (proj.skipped) {
  console.log("  (SUPABASE_ACCESS_TOKEN not set — skipping Management API checks)");
} else {
  console.log(`  project lookup failed: ${proj.status ?? ""} ${proj.error ?? proj.t ?? ""}`);
}
if (proj.j?.organization_slug) {
  const org = await mgmtGet(`/v1/organizations/${proj.j.organization_slug}`);
  if (org.j?.plan) console.log(`  plan:    ${org.j.plan}`);
}

// 2) Per-service health
const health = await mgmtGet(`/v1/projects/${ref}/health?services=db,rest,auth,realtime,storage`, 45000);
if (Array.isArray(health.j)) {
  console.log("\n  services:");
  for (const s of health.j) {
    console.log(`    ${s.name.padEnd(9)} ${s.healthy ? "OK" : "UNHEALTHY"}${s.error ? "  — " + s.error : ""}`);
  }
}

// 3) Live REST latency sample (anon, tiny query)
if (anon) {
  console.log("\n  live REST latency (anon, /rest/v1/ 3 samples):");
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: anon, Authorization: `Bearer ${anon}` },
        signal: AbortSignal.timeout(15000),
      });
      console.log(`    ${String(Math.round(performance.now() - t0)).padStart(6)} ms  (status ${r.status})`);
    } catch (e) {
      console.log(`    ${String(Math.round(performance.now() - t0)).padStart(6)} ms  (${e.name})`);
    }
  }
}

// 4) Last-hour API-gateway latency/errors (needs Management API)
if (mgmt) {
  const end = new Date();
  const start = new Date(end.getTime() - 3600e3);
  const sql = `select count(*) as n, round(avg(r.origin_time)) as avg_ms, max(r.origin_time) as max_ms, countif(r.status_code >= 500) as e5xx, countif(r.origin_time > 5000) as over5s from edge_logs cross join unnest(metadata) as m cross join unnest(m.response) as r`;
  const q = `/v1/projects/${ref}/analytics/endpoints/logs.all?iso_timestamp_start=${start.toISOString()}&iso_timestamp_end=${end.toISOString()}&sql=${encodeURIComponent(sql)}`;
  const logs = await mgmtGet(q, 45000);
  const row = logs.j?.result?.[0];
  if (row) {
    console.log("\n  API gateway, last hour:");
    console.log(`    requests: ${row.n}`);
    console.log(`    avg:      ${row.avg_ms} ms`);
    console.log(`    max:      ${row.max_ms} ms`);
    console.log(`    5xx:      ${row.e5xx}`);
    console.log(`    > 5 s:    ${row.over5s}`);
  }
}

console.log("\nHealthy baseline: services all OK, live REST < ~300 ms, gateway avg < 300 ms, 0 5xx.");
console.log("If services are UNHEALTHY or REST times out: restart the project (Dashboard → Settings → General)");
console.log("and/or upgrade compute (Pro plan → Micro/Small). Nano (Free) is 0.5 GB shared and OOMs under load.\n");
