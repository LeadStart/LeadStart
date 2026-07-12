/**
 * Probe: dump the RAW Warmforge API response for a mailbox so we can verify the
 * field names the inbox-health scorer relies on (heat_score, blacklisted,
 * blacklists, warmup_landed_inbox, warmup_landed_spam) against a live account.
 *
 * The Warmforge types (src/lib/warmforge/types.ts) are unverified against a
 * real account — this is the gate before trusting the heat_score / warmup
 * placement components. If a field is named differently live, that component
 * simply reads "unchecked" (fail-safe) until we correct the mapping here.
 *
 * Reads warmforge_api_key from the org row via the service-role key in
 * .env.local. No writes. Usage:
 *   node scripts/probe-warmforge-fields.mjs [mailbox@address]
 * If no address is passed, it probes the first mailbox listMailboxes returns.
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
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const WF_BASE = "https://api.warmforge.ai/public/v1";

async function supa(path) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  return res.json().catch(() => null);
}

async function wf(key, endpoint) {
  const res = await fetch(`${WF_BASE}${endpoint}`, {
    headers: { Authorization: key },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const orgs = await supa("organizations?select=id,name,warmforge_api_key");
const org = (orgs || []).find((o) => o.warmforge_api_key);
if (!org) {
  console.error("No organization has a warmforge_api_key set. Add it in Settings first.");
  process.exit(1);
}
console.log(`Using org ${org.name} (${org.id})`);
const key = org.warmforge_api_key;

// 1) List a few mailboxes to see the list-shape and pick a probe target.
const list = await wf(key, "/mailboxes?page=1&page_size=5");
console.log("\n=== GET /mailboxes?page=1&page_size=5 ===");
console.log("HTTP", list.status);
console.log(JSON.stringify(list.body, null, 2));

const items = Array.isArray(list.body) ? list.body : (list.body?.items ?? []);
const target = process.argv[2] || items[0]?.email;
if (!target) {
  console.error("\nNo mailbox address to probe (empty list and none passed as an argument).");
  process.exit(1);
}

// 2) The per-mailbox detail — this is what the scorer consumes.
const detail = await wf(key, `/mailboxes/${encodeURIComponent(target)}`);
console.log(`\n=== GET /mailboxes/${target} ===`);
console.log("HTTP", detail.status);
console.log(JSON.stringify(detail.body, null, 2));

console.log("\n=== Fields the scorer reads (present?) ===");
const d = detail.body && typeof detail.body === "object" ? detail.body : {};
for (const f of [
  "heat_score",
  "blacklisted",
  "blacklists",
  "warmup_landed_inbox",
  "warmup_landed_spam",
]) {
  console.log(`  ${f}: ${f in d ? JSON.stringify(d[f]) : "— ABSENT —"}`);
}
