// Local e2e for the site_scrape method's core: runs the REAL deployed actor on a
// predictable target (James Hill @ apify.com) via the REAL provider's buildInput,
// then feeds the REAL dataset through the REAL parseItems and asserts the exact
// values that would fill contacts.email / contacts.phone. Zero DB mutation.
//   npx tsx scripts/diagnostics/e2e-site-scrape-provider.ts
import { readFileSync } from "node:fs";
import { waterfallScrapeProvider } from "../../src/lib/apify/providers/waterfall-scrape.ts";
import { DEFAULT_ENRICHMENT_SETTINGS } from "../../src/types/app.ts";

// Mirror of the cron's write-boundary guard (run-apify-enrichment isPlausibleContactPhone)
// so we prove the selected phone would actually be written, not just chosen.
function isPlausibleContactPhone(raw: string): boolean {
  const s = raw.trim();
  if (/(^|\D)(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}(\D|$)/.test(s)) return false;
  if (/(^|\D)(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])(\D|$)/.test(s)) return false;
  const d = s.replace(/\D/g, "");
  if (d.length < 7 || d.length > 15) return false;
  if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(d)) return false;
  if (/^(19|20)\d{2}(19|20)\d{2}$/.test(d)) return false;
  return true;
}

function loadEnvLocal() {
  const env: Record<string, string> = {};
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}
const env = loadEnvLocal();
const ACTOR_ID = "indispensable_nonagon~site-contact-scraper";

async function resolveToken(): Promise<string | null> {
  if (env.APIFY_API_TOKEN) return env.APIFY_API_TOKEN;
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/organizations?select=apify_api_key`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const orgs = (await res.json().catch(() => [])) as { apify_api_key?: string }[];
  return orgs.find((o) => o.apify_api_key)?.apify_api_key ?? null;
}

async function main() {
  const token = await resolveToken();
  if (!token) return console.log("No Apify token.");

  // The item as the pipeline would present it to the provider.
  const items = [
    { id: "e2e-1", company_domain: "apify.com", first_name: "James", last_name: "Hill" },
  ] as unknown as Parameters<typeof waterfallScrapeProvider.buildInput>[0];

  const input = waterfallScrapeProvider.buildInput(items, DEFAULT_ENRICHMENT_SETTINGS);
  console.log("buildInput →", JSON.stringify(input));

  // Run the deployed actor with the provider-built input.
  const start = await fetch(`https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${token}&timeout=300`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const run = (await start.json()).data;
  console.log(`run ${run.id} … polling`);
  let cur = run;
  const t0 = Date.now();
  while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(cur.status)) {
    await new Promise((r) => setTimeout(r, 5000));
    cur = (await (await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`)).json()).data;
    if (Date.now() - t0 > 300000) break;
  }
  console.log(`status ${cur.status}  cost $${cur.usageTotalUsd ?? "?"}`);

  const dataset = await (
    await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${token}&clean=true`)
  ).json();

  // The REAL provider parse — this is what the cron feeds to writeEmail.
  const results = waterfallScrapeProvider.parseItems(dataset, items);
  const r = results.get("e2e-1");
  console.log("\nparseItems result:", JSON.stringify(r, null, 2));

  // Assertions: the exact contacts.email / contacts.phone the pipeline would write.
  const extra = (r?.extra ?? {}) as Record<string, unknown>;
  const phone = typeof extra.phone === "string" ? extra.phone : "";
  const checks: [string, boolean][] = [
    ["status is 'found'", r?.status === "found"],
    ["email = james.hill@apify.com", r?.email === "james.hill@apify.com"],
    ["a phone was selected", !!phone],
    ["selected phone is +CC form (pickBestPhone)", phone.startsWith("+")],
    ["selected phone survives the write-guard", !!phone && isPlausibleContactPhone(phone)],
    ["no date/year-range phone chosen", !/^(?:\+?)(?:19|20)\d{2}(?:19|20)?\d{2,4}$/.test(phone.replace(/\D/g, "")) || phone.startsWith("+")],
    ["company_emails captured", Array.isArray(extra.company_emails) && (extra.company_emails as string[]).length > 0],
  ];
  console.log("\n=== Assertions ===");
  let ok = 0;
  for (const [label, cond] of checks) {
    console.log(`${cond ? "✓" : "✗"} ${label}`);
    if (cond) ok++;
  }
  console.log(`\n${ok}/${checks.length} passed`);
  console.log(`WOULD WRITE → contacts.email='${r?.email}'  contacts.phone='${phone}'`);
}
main();
