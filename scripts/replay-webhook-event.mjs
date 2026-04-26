/**
 * Replay a captured webhook_events payload to the production webhook handler.
 *
 * Useful when a real Instantly event was logged but skipped due to a handler
 * bug — push the fix, then replay instead of asking the user to send another
 * reply.
 *
 *   node scripts/replay-webhook-event.mjs <webhook_events.id>
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
const WEBHOOK_SECRET = env.WEBHOOK_SECRET;
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_WEBHOOK_URL = "https://leadstart-ebon.vercel.app/app/api/webhooks/instantly";

const eventId = process.argv[2];
if (!eventId) throw new Error("Usage: node scripts/replay-webhook-event.mjs <webhook_events.id>");
if (!WEBHOOK_SECRET) throw new Error("WEBHOOK_SECRET missing in .env.local");

// Fetch the row.
const fetchRes = await fetch(
  `${SUPABASE_URL}/rest/v1/webhook_events?id=eq.${eventId}&select=id,event_type,payload`,
  { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } }
);
if (!fetchRes.ok) throw new Error(`Fetch failed: ${fetchRes.status} ${await fetchRes.text()}`);
const [row] = await fetchRes.json();
if (!row) throw new Error(`No webhook_events row with id ${eventId}`);
console.log(`Replaying event ${row.id} (${row.event_type})`);

// POST the payload back to the handler.
const targetUrl = `${PROD_WEBHOOK_URL}?secret=${encodeURIComponent(WEBHOOK_SECRET)}`;
const postRes = await fetch(targetUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(row.payload),
});
const body = await postRes.text();
let json;
try { json = JSON.parse(body); } catch { json = body; }
console.log(`Response (${postRes.status}):`, JSON.stringify(json, null, 2));
if (!postRes.ok) process.exit(1);
console.log("\n✅ Replay accepted. Pipeline runs async via after() — check lead_replies in ~5s.");
