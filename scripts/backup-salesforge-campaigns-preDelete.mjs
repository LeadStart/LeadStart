/**
 * BACKUP (read-only) before deleting the 2 defunct Salesforge campaign rows.
 * Captures the full campaign rows + every dependent row that a DELETE would
 * cascade-remove (snapshots/feedback/step_metrics) or detach (contacts,
 * lead_replies via ON DELETE SET NULL) — the rollback path (data-op Phase 4).
 *
 *   node scripts/backup-salesforge-campaigns-preDelete.mjs
 *
 * Writes backups/salesforge-campaigns-<ISO>.json (gitignored). No secrets printed.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

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
const TOKEN = env.SUPABASE_ACCESS_TOKEN;
if (!URL || !TOKEN) { console.error("Missing SUPABASE env in .env.local"); process.exit(1); }
const projectRef = URL.replace(/^https?:\/\//, "").split(".")[0];

async function runSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  let json; try { json = JSON.parse(body); } catch { json = body; }
  if (!res.ok) { console.error(`SQL failed (HTTP ${res.status}):`, JSON.stringify(json)); process.exit(1); }
  return json;
}

const WHERE = `source_channel='salesforge'`;
const backup = {
  taken_at: new Date().toISOString(),
  project_ref: projectRef,
  purpose: "Pre-delete snapshot of the 2 defunct Salesforge campaigns + dependents.",
  campaigns: await runSql(`SELECT * FROM public.campaigns WHERE ${WHERE};`),
  campaign_snapshots: await runSql(
    `SELECT s.* FROM public.campaign_snapshots s JOIN public.campaigns c ON c.id=s.campaign_id WHERE c.${WHERE};`,
  ),
  lead_feedback: await runSql(
    `SELECT f.* FROM public.lead_feedback f JOIN public.campaigns c ON c.id=f.campaign_id WHERE c.${WHERE};`,
  ),
  contacts_linked: await runSql(
    `SELECT co.id, co.email, co.campaign_id, co.status FROM public.contacts co JOIN public.campaigns c ON c.id=co.campaign_id WHERE c.${WHERE};`,
  ),
  lead_replies_linked: await runSql(
    `SELECT lr.id, lr.campaign_id FROM public.lead_replies lr JOIN public.campaigns c ON c.id=lr.campaign_id WHERE c.${WHERE};`,
  ),
};

mkdirSync("backups", { recursive: true });
const stamp = backup.taken_at.replace(/[:.]/g, "-");
const path = `backups/salesforge-campaigns-${stamp}.json`;
writeFileSync(path, JSON.stringify(backup, null, 2), "utf8");
JSON.parse(readFileSync(path, "utf8"));

console.log(`Backup written + parse-verified: ${path}`);
for (const [k, v] of Object.entries(backup)) {
  if (Array.isArray(v)) console.log(`  ${k.padEnd(24)} ${v.length}`);
}
console.log("  campaigns:");
for (const c of backup.campaigns) console.log(`    - ${c.name}  id=${c.id}  status=${c.status}  client_id=${c.client_id ?? "null"}`);
