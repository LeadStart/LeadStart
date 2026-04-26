/**
 * One-shot: register the LeadStart org's Instantly webhook directly via the
 * Instantly API (bypasses the owner-only UI route so it can be run from CLI).
 *
 * Reads:
 *   - WEBHOOK_SECRET from .env.local (baked into the URL Instantly will POST to)
 *   - SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL (to fetch org's instantly_api_key)
 *
 * Hardcodes the production webhook target — this script is for prod activation only,
 * not a generic helper.
 *
 *   node scripts/register-instantly-webhook.mjs
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
const PROD_APP_URL = "https://leadstart-ebon.vercel.app/app";
const TEST_INSTANTLY_CAMPAIGN_ID = "4a890fb0-a221-4156-8562-917d4d2f5a8c"; // smoke-test campaign — webhook scoped here so other campaigns can't accidentally fire

if (!WEBHOOK_SECRET) throw new Error("WEBHOOK_SECRET missing in .env.local");
if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("Supabase env missing in .env.local");

// 1. Fetch the org row.
const orgRes = await fetch(
  `${SUPABASE_URL}/rest/v1/organizations?select=id,instantly_api_key,instantly_webhook_id&limit=1`,
  {
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
  }
);
if (!orgRes.ok) throw new Error(`Supabase fetch failed: ${orgRes.status} ${await orgRes.text()}`);
const [org] = await orgRes.json();
if (!org) throw new Error("No organization row found");
console.log("Org:", { id: org.id, has_api_key: !!org.instantly_api_key, current_webhook_id: org.instantly_webhook_id });

if (org.instantly_webhook_id) {
  console.log(`\n⚠️  Webhook already registered: ${org.instantly_webhook_id}`);
  console.log("Aborting to avoid duplicate subscription. Clear instantly_webhook_id manually if you want to re-register.");
  process.exit(0);
}

if (!org.instantly_api_key) {
  throw new Error("organizations.instantly_api_key is null — set it in admin settings first.");
}

// 2. Build the webhook URL (matches what register-webhook/route.ts would build).
const webhookUrl = `${PROD_APP_URL}/api/webhooks/instantly?secret=${encodeURIComponent(WEBHOOK_SECRET)}`;
console.log("\nWebhook target URL:", webhookUrl.replace(WEBHOOK_SECRET, "***"));

// 3. Call Instantly.
const instantlyRes = await fetch("https://api.instantly.ai/api/v2/webhooks", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${org.instantly_api_key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    target_hook_url: webhookUrl,
    campaign: TEST_INSTANTLY_CAMPAIGN_ID,
    event_type: "all_events",
    name: "LeadStart — reply routing (smoke test)",
  }),
});
const instantlyBody = await instantlyRes.text();
let instantlyJson;
try { instantlyJson = JSON.parse(instantlyBody); } catch { instantlyJson = instantlyBody; }
console.log(`\nInstantly response (${instantlyRes.status}):`, JSON.stringify(instantlyJson, null, 2));
if (!instantlyRes.ok) {
  console.error("\n❌ Instantly rejected the registration.");
  process.exit(1);
}
const webhookId = instantlyJson?.id;
if (!webhookId) {
  console.error("\n❌ Instantly response missing 'id'. Cannot store webhook id.");
  process.exit(1);
}

// 4. Store the id on organizations.instantly_webhook_id.
const updateRes = await fetch(
  `${SUPABASE_URL}/rest/v1/organizations?id=eq.${org.id}`,
  {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ instantly_webhook_id: webhookId }),
  }
);
if (!updateRes.ok) {
  console.error(`\n⚠️  Stored on Instantly side as ${webhookId} but failed to PATCH organizations: ${updateRes.status} ${await updateRes.text()}`);
  console.error("Manually update organizations.instantly_webhook_id to avoid double-registration on next attempt.");
  process.exit(1);
}
const [updated] = await updateRes.json();
console.log("\n✅ Registered. organizations row:", { id: updated.id, instantly_webhook_id: updated.instantly_webhook_id });
