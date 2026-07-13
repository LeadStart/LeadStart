/**
 * BACKUP (read-only) taken before the Salesforge/Warmforge dead-object DROP.
 * Captures every value that migration 00063 will destroy, so the drop has a
 * rollback path (data-op Phase 4).
 *
 *   node scripts/backup-salesforge-warmforge-preDrop.mjs
 *
 * Writes backups/salesforge-warmforge-<ISO>.json (gitignored). Never prints
 * secrets. Reads via the Supabase Management API.
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

const backup = {
  taken_at: new Date().toISOString(),
  project_ref: projectRef,
  purpose: "Pre-drop snapshot of Salesforge/Warmforge columns + salesforge_enrollment_queue (migration 00063).",
  organizations: await runSql(
    `SELECT id, salesforge_api_key, salesforge_workspace_id, salesforge_default_product_id, warmforge_api_key FROM public.organizations;`,
  ),
  campaigns: await runSql(
    `SELECT id, name, source_channel, salesforge_sequence_id, salesforge_daily_contact_cap, salesforge_default_tags, salesforge_custom_var_mapping FROM public.campaigns;`,
  ),
  lead_replies: await runSql(
    `SELECT id, source_channel, salesforge_email_id, salesforge_thread_id, salesforge_mailbox_id FROM public.lead_replies WHERE salesforge_email_id IS NOT NULL OR salesforge_thread_id IS NOT NULL OR salesforge_mailbox_id IS NOT NULL;`,
  ),
  contacts_with_salesforge_id: await runSql(
    `SELECT id, email, campaign_id, status, salesforge_contact_id FROM public.contacts WHERE salesforge_contact_id IS NOT NULL;`,
  ),
  salesforge_enrollment_queue: await runSql(`SELECT * FROM public.salesforge_enrollment_queue;`),
};

mkdirSync("backups", { recursive: true });
const stamp = backup.taken_at.replace(/[:.]/g, "-");
const path = `backups/salesforge-warmforge-${stamp}.json`;
writeFileSync(path, JSON.stringify(backup, null, 2), "utf8");

// Parse-check the file we just wrote.
JSON.parse(readFileSync(path, "utf8"));

console.log(`Backup written + parse-verified: ${path}`);
console.log(`  organizations rows:            ${backup.organizations.length}`);
console.log(`  campaigns rows:                ${backup.campaigns.length}`);
console.log(`  lead_replies (non-null sf):    ${backup.lead_replies.length}`);
console.log(`  contacts w/ salesforge_id:     ${backup.contacts_with_salesforge_id.length}`);
console.log(`  salesforge_enrollment_queue:   ${backup.salesforge_enrollment_queue.length}`);
const seqIds = backup.campaigns.filter((c) => c.salesforge_sequence_id).map((c) => `${c.name} (source=${c.source_channel})`);
console.log(`  campaigns with a sequence id:  ${seqIds.length}${seqIds.length ? " -> " + seqIds.join(", ") : ""}`);
