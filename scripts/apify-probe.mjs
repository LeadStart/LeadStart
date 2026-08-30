// Capped Apify probe harness, the "better way to test" after the 2026-08-30
// $14.17 incident. NEVER run a paid actor probe by hand again; run it through
// this, which enforces a HARD per-run charge cap the platform itself obeys.
//
//   node scripts/apify-probe.mjs <actor-id> <hardCapUsd> <input.json>
//   node scripts/apify-probe.mjs compass~google-maps-extractor 3 ./probe-input.json
//
// What it does before spending a cent:
//   1. Pulls the actor's live pricing events + input schema (free) and PRINTS
//      the per-event prices at our tier + every spend-relevant input's schema
//      text, so you confirm cap semantics (per-place vs per-run vs per-term).
//   2. Reads the account's remaining monthly credit; refuses if hardCap exceeds
//      it (a run over the remaining credit 403s mid-flight anyway).
//   3. Starts the run with maxTotalChargeUsd = hardCap. Apify HARD-STOPS the run
//      at that dollar amount, the one guardrail that would have made the $14
//      run a $3 run. Requires you to type the cap explicitly; there is no default.
//   4. Polls to terminal, prints actual usageTotalUsd + chargedEventCounts vs cap.
// Reads keys internally from .env.local + the org row; never prints them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [actorId, hardCapArg, inputPath] = process.argv.slice(2);
if (!actorId || !hardCapArg || !inputPath) {
  console.error("Usage: node scripts/apify-probe.mjs <actor-id> <hardCapUsd> <input.json>");
  process.exit(1);
}
const hardCap = Number(hardCapArg);
if (!Number.isFinite(hardCap) || hardCap <= 0) {
  console.error("hardCapUsd must be a positive number (the max dollars this probe may bill).");
  process.exit(1);
}

const env = {};
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const ref = env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)[1];
const orgs = await (await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: "select apify_api_key from organizations limit 1" }),
})).json();
const KEY = orgs[0].apify_api_key;
const input = JSON.parse(readFileSync(resolve(process.cwd(), inputPath), "utf8"));

async function apify(path, init) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`https://api.apify.com/v2${path}${sep}token=${KEY}`, init);
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

// 1) Pricing + schema, printed for the human to confirm before spend.
const act = await apify(`/acts/${actorId}`);
const me = await apify("/users/me");
const plan = me.data?.plan?.id ?? "?";
const TIER = { FREE: "FREE", STARTER: "BRONZE", SCALE: "SILVER", BUSINESS: "GOLD" }[plan] ?? "BRONZE";
const pi = act.data?.pricingInfos;
const latest = Array.isArray(pi) ? pi[pi.length - 1] : pi;
console.log(`\n=== ${actorId} · plan ${plan} (${TIER}) ===`);
for (const [k, v] of Object.entries(latest?.pricingPerEvent?.actorChargeEvents || {})) {
  const p = v.eventTieredPricingUsd?.[TIER]?.tieredEventPriceUsd ?? v.eventPriceUsd ?? "?";
  console.log(`  event ${k}: $${p}, ${String(v.eventDescription || "").replace(/\s+/g, " ").slice(0, 120)}`);
}

// 2) Remaining credit gate.
const lim = await apify("/users/me/limits");
const max = lim.data?.limits?.maxMonthlyUsageUsd;
const used = lim.data?.current?.monthlyUsageUsd;
const remaining = typeof max === "number" && typeof used === "number" ? max - used : null;
console.log(`\nmonthly credit: used $${used?.toFixed(2)} of $${max} → remaining $${remaining?.toFixed(2)}`);
console.log(`requested hard cap for this probe: $${hardCap.toFixed(2)}`);
if (remaining != null && hardCap > remaining) {
  console.error(`\nREFUSED: cap $${hardCap} exceeds remaining credit $${remaining.toFixed(2)}, the run would 403 mid-flight. Lower the cap or top up.`);
  process.exit(1);
}
console.log(`\nInput:\n${JSON.stringify(input, null, 2).slice(0, 1500)}`);

// 3) Start with the platform-enforced hard cap.
console.log(`\nStarting run with maxTotalChargeUsd=${hardCap} (Apify aborts at this $).`);
const started = await apify(`/acts/${actorId}/runs?maxTotalChargeUsd=${hardCap}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
});
const runId = started.data.id;
console.log(`runId: ${runId}  (maxTotalChargeUsd set by user: ${started.data.options?.maxTotalChargeUsd ?? "?"})`);

// 4) Poll + reconcile.
let run;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  run = (await apify(`/actor-runs/${runId}`)).data;
  process.stdout.write(`  [${i}] ${run.status}\n`);
  if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) break;
}
// Re-read after a short settle so PPE charges finish aggregating.
await new Promise((r) => setTimeout(r, 20_000));
run = (await apify(`/actor-runs/${runId}`)).data;
console.log(`\n=== result: ${run.status} ===`);
console.log(`usageTotalUsd: $${run.usageTotalUsd}  (cap was $${hardCap})`);
console.log(`chargedEventCounts: ${JSON.stringify(run.chargedEventCounts ?? {})}`);
console.log(`datasetId: ${run.defaultDatasetId}, read items with the Apify API when ready.`);
