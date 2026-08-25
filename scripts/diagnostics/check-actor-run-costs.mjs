// Diagnostic: read the LAST few runs of each enrichment actor straight from the
// Apify API and print their FINAL usageTotalUsd — to compare against what the
// worker captured on enrichment_runs.cost_usd. Token is read internally from the
// org row via Supabase REST and never printed.
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
const SUPA = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !SERVICE) {
  console.error("Missing Supabase env");
  process.exit(1);
}

const orgRes = await fetch(`${SUPA}/rest/v1/organizations?select=apify_api_key&limit=1`, {
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
});
const orgs = await orgRes.json();
const token = orgs?.[0]?.apify_api_key;
if (!token) {
  console.error("No apify key on org");
  process.exit(1);
}

const ACTORS = [
  "harvestapi~linkedin-profile-search",
  "harvestapi~linkedin-profile-scraper",
  "harvestapi~linkedin-company",
];

for (const actor of ACTORS) {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${actor}/runs?token=${token}&limit=3&desc=1`,
  );
  if (!res.ok) {
    console.log(`${actor}: HTTP ${res.status}`);
    continue;
  }
  const data = await res.json();
  const runs = data?.data?.items ?? [];
  console.log(`\n=== ${actor} (last ${runs.length} runs) ===`);
  for (const r of runs) {
    console.log(
      `  ${r.startedAt}  ${r.status}  usageTotalUsd=$${(r.usageTotalUsd ?? 0).toFixed(4)}`,
    );
  }
}
