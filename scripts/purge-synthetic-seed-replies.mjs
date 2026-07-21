/**
 * Purge synthetic / smoke-test seed data from prod.
 *
 *   node scripts/purge-synthetic-seed-replies.mjs           # dry run (counts only)
 *   node scripts/purge-synthetic-seed-replies.mjs --apply   # delete
 *
 * ALREADY RAN 2026-07-20 against prod (org bfc96611…): removed 17 synthetic
 * lead_replies + the fake "Smoke Test" client (CASCADE also took 1 client_user
 * + 2 kpi_reports). Idempotent — after that run both predicates match 0 rows,
 * so a re-run is a no-op.
 *
 * The seed data was two families:
 *   1. 14 templated personas on @example-inbound-test.com (Sarah Chen, Daniel
 *      Ortiz, Taylor Brooks, Chris Hale, Morgan Reed, Alex Winters, Jordan
 *      Park) — each inserted twice (under "Rainier Facility Solutions" and
 *      "David Cabrera"). source_channel NULL, all dated 2026-04-21.
 *   2. 3 replies under the "Smoke Test" client (2× "Synthetic Smoke", 1×
 *      "Daniel Tuccillo") — seeded by the former
 *      scripts/create-smoke-test-client-user.mjs (removed in this same cleanup).
 *
 * Real replies (SaaSassins not-interested + David Cabrera native_email
 * unsubscribes/OOO — real domains, real threads) are matched by NEITHER
 * predicate and are preserved.
 */
import { readFileSync } from "node:fs";

const SMOKE_CLIENT_ID = "4c39db38-2b7c-4183-ae7e-bb5eb4647719";
const TEST_EMAIL_DOMAIN = "@example-inbound-test.com";
const APPLY = process.argv.includes("--apply");

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
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

async function rest(method, path, { prefer } = {}) {
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  if (prefer) headers["Prefer"] = prefer;
  const res = await fetch(`${BASE}/rest/v1/${path}`, { method, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
  return json;
}

// or=(lead_email ilike *@example-inbound-test.com, client_id = <smoke>)
const replyFilter = `or=(lead_email.ilike.*${TEST_EMAIL_DOMAIN},client_id.eq.${SMOKE_CLIENT_ID})`;

const matchedReplies = await rest("GET", `lead_replies?${replyFilter}&select=id,final_class,lead_email`);
const smokeClient = await rest("GET", `clients?id=eq.${SMOKE_CLIENT_ID}&select=id,name`);
console.log(`synthetic lead_replies matched : ${matchedReplies.length}`);
console.log(`smoke-test client present      : ${smokeClient.length}`);

if (!APPLY) {
  console.log("\nDRY RUN — pass --apply to delete. (No writes performed.)");
} else {
  const delReplies = await rest("DELETE", `lead_replies?${replyFilter}`, { prefer: "return=representation" });
  const delClient = await rest("DELETE", `clients?id=eq.${SMOKE_CLIENT_ID}`, { prefer: "return=representation" });
  console.log(`\ndeleted lead_replies : ${Array.isArray(delReplies) ? delReplies.length : 0}`);
  console.log(`deleted clients      : ${Array.isArray(delClient) ? delClient.length : 0} (CASCADE removes its client_users + kpi_reports)`);
  console.log("DONE.");
}
