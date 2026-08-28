// READ-ONLY probe: confirm the just-authorized DWD scopes + admin impersonation
// actually work against real Google. Uses the app's own Google clients
// (src/lib/google) with the org's stored SA creds. No writes, nothing created.
// The SA private key is read into memory and NEVER printed.
// Run from repo root: npx tsx scripts/probe-google-workspace.ts
import { readFileSync } from "node:fs";
import { GoogleServiceAccount } from "../src/lib/google/auth.ts";
import { DirectoryClient } from "../src/lib/google/directory.ts";

const PROJECT_REF = "exedxjrifprqgftyuroc";
const ORG_ID = "bfc96611-8b2f-49c2-b4e0-49ebadc295e1";
const DOMAIN = "workwithdanielt.com";
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

async function main() {
  const token = loadEnvLocal().SUPABASE_ACCESS_TOKEN;
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `SELECT gmail_service_account_email, gmail_service_account_key, google_admin_email FROM organizations WHERE id = '${ORG_ID}';`,
    }),
  });
  const [org] = (await res.json()) as {
    gmail_service_account_email: string;
    gmail_service_account_key: string;
    google_admin_email: string;
  }[];
  console.log(`SA: ${org.gmail_service_account_email}`);
  console.log(`Admin subject: ${org.google_admin_email}`);

  const sa = new GoogleServiceAccount(org.gmail_service_account_email, org.gmail_service_account_key);
  const directory = new DirectoryClient(sa, org.google_admin_email);

  console.log("\n--- Directory API: get domain (read-only) ---");
  try {
    const d = await directory.getDomain(DOMAIN);
    console.log(`getDomain(${DOMAIN}) ->`, JSON.stringify(d));
  } catch (err) {
    console.log(`getDomain FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n--- Directory API: get admin user (read-only) ---");
  try {
    const u = await directory.getUser(org.google_admin_email);
    console.log(`getUser(${org.google_admin_email}) ->`, JSON.stringify(u));
  } catch (err) {
    console.log(`getUser FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
