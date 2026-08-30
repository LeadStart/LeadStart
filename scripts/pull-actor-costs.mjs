// Live Apify actor cost + cap-semantics pull (READ-ONLY, free, no runs).
//
//   node scripts/pull-actor-costs.mjs                  # all actors we use
//   node scripts/pull-actor-costs.mjs compass~google-maps-extractor
//
// THE PRE-RUN PROTOCOL (docs/APIFY_ACTOR_COSTS.md) requires running this before
// ANY paid actor run: it prints every charge event at OUR plan tier and the
// schema description of every spend-relevant input VERBATIM, so cap semantics
// (per-run vs per-place vs per-term) are read from the source, never assumed
// from field names. Created after the 2026-08-30 $14.17 per-place-cap incident.
//
// Reads .env.local for Supabase, pulls the org's Apify key from the DB
// internally, and never prints any secret.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "../.env.local");

const DEFAULT_ACTORS = [
  "compass~google-maps-extractor",
  "harvestapi~linkedin-profile-search",
  "harvestapi~linkedin-profile-scraper",
  "harvestapi~linkedin-company",
  "harvestapi~linkedin-profile-posts",
  "indispensable_nonagon~site-contact-scraper",
  "bovi~email-finder-bulk",
];

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
const ref = env.NEXT_PUBLIC_SUPABASE_URL?.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!ref || !env.SUPABASE_ACCESS_TOKEN) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_ACCESS_TOKEN in .env.local");
  process.exit(1);
}

const orgRows = await (await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: "select apify_api_key from organizations limit 1" }),
})).json();
const KEY = orgRows?.[0]?.apify_api_key;
if (!KEY) {
  console.error("No apify_api_key on the org row.");
  process.exit(1);
}

async function apify(path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`https://api.apify.com/v2${path}${sep}token=${KEY}`);
  const t = await r.text();
  if (!r.ok) return { __err: `${r.status}: ${t.slice(0, 150)}` };
  try {
    return JSON.parse(t);
  } catch {
    return { __err: "non-JSON" };
  }
}

// Plan tier, PPE tiered prices key off this (Starter → BRONZE).
const me = await apify("/users/me");
const plan = me.data?.plan?.id ?? "?";
const TIER = { FREE: "FREE", STARTER: "BRONZE", SCALE: "SILVER", BUSINESS: "GOLD" }[plan] ?? "BRONZE";
console.log(`plan: ${plan} → PPE tier ${TIER}\n`);

const SPEND_FIELD_RE = /max|limit|cap|leads|contact|enrich|social|verif|scrape|depth|mode|filter|stars|website|records|items|count/i;
const actors = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ACTORS;

for (const id of actors) {
  const act = await apify(`/acts/${id}`);
  if (act.__err) {
    console.log(`### ${id}: ERROR ${act.__err}\n`);
    continue;
  }
  const d = act.data;
  const pi = d.pricingInfos;
  const latest = Array.isArray(pi) ? pi[pi.length - 1] : pi;
  console.log(`### ${id}, ${latest?.pricingModel ?? "(no PPE, raw compute)"}`);

  const events = latest?.pricingPerEvent?.actorChargeEvents || {};
  for (const [k, v] of Object.entries(events)) {
    const our = v.eventTieredPricingUsd?.[TIER]?.tieredEventPriceUsd ?? v.eventPriceUsd ?? "?";
    console.log(`  event ${k}: $${our}`);
    console.log(`    ${String(v.eventDescription ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
  }

  const buildTag = d.defaultRunOptions?.build || "latest";
  const buildId = d.taggedBuilds?.[buildTag]?.buildId;
  if (buildId) {
    const build = await apify(`/actor-builds/${buildId}`);
    const schemaRaw = build.data?.inputSchema;
    const schema = typeof schemaRaw === "string" ? JSON.parse(schemaRaw) : schemaRaw;
    console.log("  spend-relevant inputs (schema text VERBATIM, semantics live here):");
    for (const [k, v] of Object.entries(schema?.properties || {})) {
      if (!SPEND_FIELD_RE.test(k)) continue;
      console.log(`  - ${k} [${v.type}, default ${JSON.stringify(v.default ?? null)}] ${v.title ?? ""}`);
      const desc = String(v.description ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
      if (desc) console.log(`      ${desc.slice(0, 300)}`);
    }
  }
  console.log("");
}

console.log("Reminder: worst case = every event × the max count your input permits.");
console.log("If an event's count is not bounded by an input you control, DO NOT RUN.");
