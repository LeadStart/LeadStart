/**
 * Diagnostic: check the deploy/build status of the site-contact-scraper Apify actor.
 * Resolves the org's Apify token from the DB (or APIFY_API_TOKEN env) INTERNALLY and
 * prints ONLY actor + build status (never the token). Read-only against Apify.
 *
 *   node scripts/diagnostics/check-site-scraper-build.mjs [actorId]
 *
 * Default actorId = indispensable_nonagon~site-contact-scraper (the pushed actor).
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

async function sbRest(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  });
  return res.json().catch(() => null);
}

async function resolveApifyToken() {
  if (env.APIFY_API_TOKEN) return { token: env.APIFY_API_TOKEN, source: "env APIFY_API_TOKEN" };
  const orgs = (await sbRest("organizations?select=id,name,apify_api_key")) || [];
  const withKey = orgs.filter((o) => o.apify_api_key);
  if (!withKey.length) return { token: null, source: "no org has apify_api_key" };
  const o = withKey[0];
  return { token: o.apify_api_key, source: `org "${o.name}"`, orgCount: withKey.length };
}

async function apify(path, token) {
  const url = `https://api.apify.com/v2/${path}${path.includes("?") ? "&" : "?"}token=${token}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const { token, source, orgCount } = await resolveApifyToken();
console.log(`Apify token source: ${source}${orgCount ? ` (${orgCount} orgs have a key)` : ""}`);
if (!token) {
  console.log("No Apify token reachable, cannot query the Apify API.");
  process.exit(1);
}

// 1) Actor object: confirm it exists + read its tagged builds (latest tag).
const act = await apify(`acts/${ACTOR_ID}`, token);
console.log(`\n=== Actor ${ACTOR_ID} ===  HTTP ${act.status}`);
if (act.status !== 200) {
  console.log("Actor not found / not accessible with this token:");
  console.log(JSON.stringify(act.body, null, 2)?.slice(0, 800));
  process.exit(1);
}
const a = act.body?.data || {};
console.log(`name:        ${a.username}/${a.name}`);
console.log(`title:       ${a.title || "(none)"}`);
console.log(`isPublic:    ${a.isPublic}`);
console.log(`defaultRunOptions: ${JSON.stringify(a.defaultRunOptions || {})}`);
const tagged = a.taggedBuilds || {};
console.log(`taggedBuilds: ${JSON.stringify(tagged)}`);

// 2) Recent builds with status.
const builds = await apify(`acts/${ACTOR_ID}/builds?desc=true&limit=6`, token);
const items = builds.body?.data?.items || [];
console.log(`\n=== Recent builds (${items.length}) ===`);
for (const b of items) {
  console.log(
    `#${b.buildNumber}  ${b.status.padEnd(10)}  started=${b.startedAt || "?"}  finished=${b.finishedAt || "-"}  id=${b.id}`,
  );
}

// 3) If the newest build didn't SUCCEED, pull its log tail to diagnose.
const newest = items[0];
if (newest && newest.status !== "SUCCEEDED") {
  console.log(`\n=== Build #${newest.buildNumber} is ${newest.status}, fetching log tail ===`);
  const logRes = await fetch(
    `https://api.apify.com/v2/actor-builds/${newest.id}/log?token=${token}`,
  );
  const log = await logRes.text().catch(() => "");
  const lines = log.split(/\r?\n/);
  console.log(lines.slice(-60).join("\n"));
} else if (newest) {
  console.log(`\nNewest build #${newest.buildNumber} SUCCEEDED, actor is ready to run.`);
}
