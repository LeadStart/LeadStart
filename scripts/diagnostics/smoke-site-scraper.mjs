/**
 * Smoke-test the site-contact-scraper actor on a diverse set of domains.
 * Resolves the Apify token internally (DB or env), starts one run, polls to
 * completion, then prints run stats + per-domain extraction + the log tail so we
 * can read the fetch-tier distribution. Read-only apart from the one actor run.
 *
 *   node scripts/diagnostics/smoke-site-scraper.mjs
 */
import { readFileSync } from "node:fs";

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}
const env = loadEnvLocal();
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SRK = env.SUPABASE_SERVICE_ROLE_KEY;
const ACTOR_ID = process.argv[2] || "indispensable_nonagon~site-contact-scraper";

async function resolveApifyToken() {
  if (env.APIFY_API_TOKEN) return env.APIFY_API_TOKEN;
  const res = await fetch(`${SB_URL}/rest/v1/organizations?select=apify_api_key`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  });
  const orgs = (await res.json().catch(() => [])) || [];
  const o = orgs.find((x) => x.apify_api_key);
  return o?.apify_api_key || null;
}

const token = await resolveApifyToken();
if (!token) {
  console.log("No Apify token reachable.");
  process.exit(1);
}

// static / mailto-heavy · JS-heavy corp · real person-name for personMatch
const input = {
  targets: [
    { domain: "gnu.org" },
    { domain: "apify.com", firstName: "Jan", lastName: "Curn" },
    { domain: "twilio.com" },
  ],
  maxPagesPerDomain: 6,
  useProxy: false,
};

console.log(`Starting run: ${ACTOR_ID}`);
console.log(`targets: ${input.targets.map((t) => t.domain).join(", ")}`);

const startRes = await fetch(
  `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${token}&timeout=600`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
);
const startBody = await startRes.json().catch(() => null);
if (startRes.status !== 201) {
  console.log(`Start failed HTTP ${startRes.status}:`, JSON.stringify(startBody, null, 2)?.slice(0, 800));
  process.exit(1);
}
const run = startBody.data;
console.log(`run id: ${run.id}  status: ${run.status}  dataset: ${run.defaultDatasetId}`);

async function getRun() {
  const r = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
  return (await r.json()).data;
}

const startedAt = Date.now();
let cur = run;
while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(cur.status)) {
  await new Promise((r) => setTimeout(r, 5000));
  cur = await getRun();
  const secs = Math.round((Date.now() - startedAt) / 1000);
  process.stdout.write(`  [${secs}s] ${cur.status}\r`);
  if (secs > 600) {
    console.log("\nGiving up polling at 10 min.");
    break;
  }
}
console.log(`\nFinal status: ${cur.status}`);
const st = cur.stats || {};
console.log(`runtime: ${st.runTimeSecs ?? "?"}s  computeUnits: ${st.computeUnits ?? "?"}`);
if (cur.usageTotalUsd != null) console.log(`usageTotalUsd: $${cur.usageTotalUsd}`);

// Dataset items
const dsRes = await fetch(
  `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${token}&clean=true`,
);
const items = (await dsRes.json().catch(() => [])) || [];
console.log(`\n=== Dataset: ${items.length} record(s) ===`);
for (const r of items) {
  console.log(`\n▶ ${r.domain}`);
  console.log(`  fetchOutcome=${r.fetchOutcome}  usedBrowser=${r.usedBrowser}  pagesFetched=${r.pagesFetched}${r.error ? `  error=${r.error}` : ""}`);
  console.log(`  companyEmails(${(r.companyEmails || []).length}): ${(r.companyEmails || []).slice(0, 8).join(", ")}`);
  const pe = (r.personEmails || []).map((p) => `${p.email}${p.nameMatched ? "*" : ""}`);
  console.log(`  personEmails(${pe.length}): ${pe.slice(0, 8).join(", ")}`);
  console.log(`  phones(${(r.phones || []).length}): ${(r.phones || []).slice(0, 8).join(", ")}`);
  const soc = r.socials || {};
  const socStr = Object.entries(soc).map(([k, v]) => `${k}:${v}`).slice(0, 5).join(", ");
  if (socStr) console.log(`  socials: ${socStr}`);
}

// Log tail — shows tier escalation decisions
const logRes = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}/log?token=${token}`);
const log = await logRes.text().catch(() => "");
const lines = log.split(/\r?\n/).filter(Boolean);
console.log(`\n=== Run log tail (${Math.min(50, lines.length)} of ${lines.length} lines) ===`);
console.log(lines.slice(-50).join("\n"));
