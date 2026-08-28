// READ-ONLY: list every domain on the org's Google Workspace tenant (Directory
// domains.list), vs what LeadStart's sending_domains table tracks. Shows the gap
// between "all domains on the Workspace" and "domains hooked up to LeadStart".
// No writes. SA key read into memory, never printed.
// Run from repo root: npx tsx scripts/probe-workspace-domains.ts
import { readFileSync } from "node:fs";
import { GoogleServiceAccount, googleApiFetch } from "../src/lib/google/auth.ts";
import { DIRECTORY_SCOPES } from "../src/lib/google/directory.ts";

const PROJECT_REF = "exedxjrifprqgftyuroc";
const ORG_ID = "bfc96611-8b2f-49c2-b4e0-49ebadc295e1";
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}

async function sql(token: string, query: string) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

async function main() {
  const token = loadEnvLocal().SUPABASE_ACCESS_TOKEN;
  const [org] = (await sql(
    token,
    `SELECT gmail_service_account_email, gmail_service_account_key, google_admin_email FROM organizations WHERE id = '${ORG_ID}';`,
  )) as { gmail_service_account_email: string; gmail_service_account_key: string; google_admin_email: string }[];

  const sa = new GoogleServiceAccount(org.gmail_service_account_email, org.gmail_service_account_key);

  console.log(`Workspace admin subject: ${org.google_admin_email}\n`);
  console.log("=== ALL domains on this Workspace tenant (Google Directory) ===");
  const { json } = await googleApiFetch<{
    domains?: { domainName: string; verified?: boolean; isPrimary?: boolean }[];
  }>({
    sa,
    subject: org.google_admin_email,
    scopes: DIRECTORY_SCOPES,
    baseUrl: "https://admin.googleapis.com/admin/directory/v1",
    path: "/customer/my_customer/domains",
    apiLabel: "Directory",
  });
  const domains = json.domains ?? [];
  for (const d of domains) {
    console.log(`  ${d.domainName}${d.isPrimary ? " (primary)" : ""} — verified: ${d.verified}`);
  }
  console.log(`  total: ${domains.length}`);

  console.log("\n=== Domains LeadStart tracks (sending_domains) ===");
  const rows = (await sql(
    token,
    `SELECT domain, tier, lifecycle_status, registrar FROM sending_domains WHERE organization_id = '${ORG_ID}' ORDER BY domain;`,
  )) as { domain: string; tier: string; lifecycle_status: string; registrar: string }[];
  for (const r of rows) console.log(`  ${r.domain} — ${r.tier}/${r.lifecycle_status}/${r.registrar}`);
  console.log(`  total: ${rows.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
