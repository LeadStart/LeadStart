// Validate the live-pricing parser against the real Apify account.
//   npx tsx scripts/diagnostics/test-live-pricing.ts
import { readFileSync } from "node:fs";
import { fetchLivePricing } from "../../src/lib/apify/live-pricing.js";
function env() {
  const e: Record<string, string> = {};
  for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) e[m[1]] = m[3];
  }
  return e;
}
const E = env();
async function main() {
  const r = await fetch(`${E.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/organizations?select=apify_api_key`, {
    headers: { apikey: E.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${E.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const token = (await r.json()).find((o: { apify_api_key?: string }) => o.apify_api_key)?.apify_api_key;
  const p = await fetchLivePricing(token);
  console.log(JSON.stringify(p, null, 2));
  console.log("\nExpect ~ sourcing {short 0.004, full 0.008, full_email 0.014}; profile 0.01, domain 0.004, bovi ~0.0049");
}
main();
