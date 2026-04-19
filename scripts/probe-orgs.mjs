/**
 * Probe: investigate the two "LeadStart Agency" organization rows.
 * Find which one owns what (clients, profiles, campaigns), created_at, etc.
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
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

async function rest(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "count=exact" },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const orgs = await rest("organizations?select=*");
console.log("=== Organizations (full) ===");
for (const o of orgs.body || []) {
  console.log(JSON.stringify(o, null, 2));
  console.log("---");
}

// Count per-org ownership
for (const o of orgs.body || []) {
  console.log(`\n=== Usage of org ${o.id} (${o.name}) ===`);
  const [clients, contacts, campaigns, profiles, kpi, feedback, tasks] = await Promise.all([
    rest(`clients?organization_id=eq.${o.id}&select=id,name`),
    rest(`contacts?organization_id=eq.${o.id}&select=id`),
    rest(`campaigns?organization_id=eq.${o.id}&select=id,name`),
    rest(`profiles?organization_id=eq.${o.id}&select=id,email,role,full_name`),
    rest(`kpi_reports?organization_id=eq.${o.id}&select=id`),
    rest(`lead_feedback?select=id&limit=1`), // feedback uses campaign_id not org directly
    rest(`tasks?organization_id=eq.${o.id}&select=id`),
  ]);
  console.log(`  clients:    ${(clients.body || []).length}`);
  console.log(`  contacts:   ${(contacts.body || []).length}`);
  console.log(`  campaigns:  ${(campaigns.body || []).length}`);
  console.log(`  profiles:   ${(profiles.body || []).length}`);
  console.log(`  kpi_reports:${(kpi.body || []).length}`);
  console.log(`  tasks:      ${(tasks.body || []).length}`);

  if ((profiles.body || []).length) {
    console.log("  Profiles:");
    for (const p of profiles.body) {
      console.log(`    ${p.email}  role=${p.role}  name=${p.full_name}`);
    }
  }
  if ((clients.body || []).length) {
    console.log("  Clients:");
    for (const c of clients.body) console.log(`    ${c.name} (${c.id})`);
  }
  if ((campaigns.body || []).length) {
    console.log("  Campaigns:");
    for (const c of campaigns.body) console.log(`    ${c.name} (${c.id})`);
  }
}
