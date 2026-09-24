/**
 * Backfill contacts.campaign_id for David Cabrera's "Buyer Agent Outreach".
 *
 *   node scripts/backfill-david-campaign-id.mjs            # dry run + backup, NO writes
 *   node scripts/backfill-david-campaign-id.mjs --apply    # take backup, then write prod
 *
 * WHY: the campaign was built by build-david-cabrera-campaign.mjs, which inserts
 * contacts with `campaign_id: null` (line 408) and enrolls them directly into
 * campaign_enrollments (lines 485-495). The dispatcher sends off enrollments, so
 * sending works; the Contacts tab counts contacts.campaign_id, so it showed 0.
 * This sets campaign_id on the enrolled contacts so the tab reflects reality.
 *
 * SAFE: verified read-only that neither the send cron (run-native-sequences) nor
 * the reply poller (poll-native-replies) reads contacts.campaign_id, so this is
 * display-only and does not change what is sent or how replies are handled.
 *
 * Idempotent: after --apply a re-run updates 0 rows (campaign_id no longer null).
 * Rollback: set campaign_id = null for the ids captured in the backup JSON.
 *
 * Uses the Supabase Management API (SUPABASE_ACCESS_TOKEN from .env.local); the
 * token is read internally and never printed. Project exedxjrifprqgftyuroc.
 *
 * RAN: 2026-09-24 with --apply against prod. 752 rows set. RECONCILED
 * (assigned 0 -> 752, enrollments unchanged 752, target 0). Backup:
 * C:\Users\danie\Documents\Clients\David Cabrera\campaign-id-backfill-backup-2026-09-24T18-00-49-058Z.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---- Fixed identifiers (verified against prod 2026-09-24) ----
const PROJECT_REF = "exedxjrifprqgftyuroc";
const CAMPAIGN_ID = "f9c179e6-799d-44f4-8753-806fcc1c2b83"; // David Cabrera — Buyer Agent Outreach
const CLIENT_ID = "9b15943d-ef85-4b5c-a9cb-01c911c542b8"; // David Cabrera
const BACKUP_DIR = "C:\\Users\\danie\\Documents\\Clients\\David Cabrera";

// ---- env + Management API SQL ----
function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}
const TOKEN = loadEnvLocal().SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN in .env.local");
  process.exit(1);
}

async function sql(query) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ------------------------------------------------------------------ main
const APPLY = process.argv.slice(2).includes("--apply");
console.log(`Mode: ${APPLY ? "APPLY (writing to prod)" : "DRY RUN (no writes)"}\n`);

// 1) Audit: current state
const [state] = await sql(`
  select
    (select count(*) from contacts where campaign_id = '${CAMPAIGN_ID}') as assigned_now,
    (select count(*) from campaign_enrollments where campaign_id = '${CAMPAIGN_ID}') as enrolled_total,
    (select count(*) from contacts
       where client_id = '${CLIENT_ID}' and campaign_id is null
         and id in (select contact_id from campaign_enrollments where campaign_id = '${CAMPAIGN_ID}')
    ) as target_to_backfill
`);
console.log("Current state:");
console.log(`  contacts assigned (campaign_id set) : ${state.assigned_now}`);
console.log(`  enrollments (dispatcher sends off)  : ${state.enrolled_total}`);
console.log(`  target rows to backfill             : ${state.target_to_backfill}`);
console.log(`\nPredicted after apply:`);
console.log(`  assigned ${state.assigned_now} -> ${Number(state.assigned_now) + Number(state.target_to_backfill)} (== enrolled ${state.enrolled_total})`);
console.log(`  target_to_backfill ${state.target_to_backfill} -> 0\n`);

// 2) Backup (read-only) BEFORE any write — the exact target rows + pre-state.
const targetRows = await sql(`
  select id, email, campaign_id, status
  from contacts
  where client_id = '${CLIENT_ID}' and campaign_id is null
    and id in (select contact_id from campaign_enrollments where campaign_id = '${CAMPAIGN_ID}')
  order by email
`);
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(BACKUP_DIR, `campaign-id-backfill-backup-${stamp}.json`);
const backup = {
  taken_at: new Date().toISOString(),
  project: PROJECT_REF,
  campaign_id: CAMPAIGN_ID,
  client_id: CLIENT_ID,
  note: "Pre-backfill snapshot. Rollback = set contacts.campaign_id=null for these ids.",
  row_count: targetRows.length,
  rows: targetRows,
};
writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
// Sanity: re-read + parse the backup before proceeding.
const reparsed = JSON.parse(readFileSync(backupPath, "utf8"));
if (reparsed.row_count !== targetRows.length) {
  console.error("Backup sanity check failed: row_count mismatch. Aborting.");
  process.exit(1);
}
console.log(`Backup written + verified: ${backupPath} (${reparsed.row_count} rows)\n`);

if (!APPLY) {
  console.log("DRY RUN complete. No database changes made. Re-run with --apply to write.");
  process.exit(0);
}

// 3) Execute: idempotent, precisely scoped UPDATE.
const updated = await sql(`
  update contacts
  set campaign_id = '${CAMPAIGN_ID}', updated_at = now()
  where client_id = '${CLIENT_ID}' and campaign_id is null
    and id in (select contact_id from campaign_enrollments where campaign_id = '${CAMPAIGN_ID}')
  returning id
`);
console.log(`UPDATE complete: ${updated.length} rows set to campaign_id=${CAMPAIGN_ID}\n`);

// 4) Verify: re-audit and reconcile.
const [after] = await sql(`
  select
    (select count(*) from contacts where campaign_id = '${CAMPAIGN_ID}') as assigned_now,
    (select count(*) from campaign_enrollments where campaign_id = '${CAMPAIGN_ID}') as enrolled_total,
    (select count(*) from contacts
       where client_id = '${CLIENT_ID}' and campaign_id is null
         and id in (select contact_id from campaign_enrollments where campaign_id = '${CAMPAIGN_ID}')
    ) as target_remaining
`);
console.log("Post-op verify:");
console.log(`  contacts assigned : ${after.assigned_now}  (expected ${state.enrolled_total})`);
console.log(`  enrollments       : ${after.enrolled_total} (unchanged, expected ${state.enrolled_total})`);
console.log(`  target remaining  : ${after.target_remaining} (expected 0)`);
const ok =
  Number(after.assigned_now) === Number(state.enrolled_total) &&
  Number(after.enrolled_total) === Number(state.enrolled_total) &&
  Number(after.target_remaining) === 0;
console.log(ok ? "\nRECONCILED ✓" : "\nMISMATCH — investigate, backup is the rollback path.");
process.exit(ok ? 0 : 1);
