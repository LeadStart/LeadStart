/**
 * Delete the no-first-name contacts from David Cabrera's "Buyer Agent Outreach".
 *
 *   node scripts/delete-david-noname-contacts.mjs           # dry run + backup, NO writes
 *   node scripts/delete-david-noname-contacts.mjs --apply   # take backup, then delete
 *
 * WHY: 57 rows in the imported CSV had no Buyer Agent First/Last name (blank at
 * source, not a mapping glitch). {{FirstName}} would render "Hi ," for them, so
 * per the owner they are removed rather than emailed with a fallback.
 *
 * SCOPE (verified 2026-09-24): contacts in this campaign with a null/empty
 * first_name = exactly 57, all created 2026-09-24, and NONE have been sent to
 * (0 native_sends), so no send/reply history is lost. Deleting a contact
 * CASCADEs to campaign_enrollments / native_sends / enrichment_run_items /
 * manual_tasks (all verified ON DELETE CASCADE); lead_replies key off email and
 * these have 0 replies.
 *
 * REVERSIBLE: a full snapshot of the deleted contacts + their enrollments is
 * written to the David Cabrera client folder before any delete. Restore = re-insert
 * those rows. Idempotent: a second --apply run deletes 0 (they are already gone).
 *
 * Uses the Supabase Management API (SUPABASE_ACCESS_TOKEN from .env.local); the
 * token is read internally and never printed. Project exedxjrifprqgftyuroc.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PROJECT_REF = "exedxjrifprqgftyuroc";
const CAMPAIGN_ID = "f9c179e6-799d-44f4-8753-806fcc1c2b83";
const CLIENT_ID = "9b15943d-ef85-4b5c-a9cb-01c911c542b8";
const BACKUP_DIR = "C:\\Users\\danie\\Documents\\Clients\\David Cabrera";
// Target predicate, shared by audit / backup / delete so all three agree.
const WHERE = `campaign_id = '${CAMPAIGN_ID}' and (first_name is null or first_name = '')`;

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

const APPLY = process.argv.slice(2).includes("--apply");
console.log(`Mode: ${APPLY ? "APPLY (deleting from prod)" : "DRY RUN (no writes)"}\n`);

// 1) Audit
const [state] = await sql(`
  select
    (select count(*) from contacts where ${WHERE}) as to_delete,
    (select count(*) from contacts where campaign_id='${CAMPAIGN_ID}') as assigned_now,
    (select count(*) from campaign_enrollments where campaign_id='${CAMPAIGN_ID}') as enrolled_now,
    (select count(*) from native_sends s where s.contact_id in (select id from contacts where ${WHERE})) as their_sends
`);
console.log("Current state:");
console.log(`  contacts to delete (no first name) : ${state.to_delete}`);
console.log(`  their sends (must be 0)            : ${state.their_sends}`);
console.log(`  campaign assigned now             : ${state.assigned_now}`);
console.log(`  campaign enrolled now             : ${state.enrolled_now}`);
console.log(`\nPredicted after delete:`);
console.log(`  assigned ${state.assigned_now} -> ${Number(state.assigned_now) - Number(state.to_delete)}`);
console.log(`  enrolled ${state.enrolled_now} -> ${Number(state.enrolled_now) - Number(state.to_delete)}`);
console.log(`  no-first-name remaining -> 0\n`);

if (Number(state.their_sends) > 0) {
  console.error(`ABORT: ${state.their_sends} of the targets have send history; refusing to destroy it. Re-scope.`);
  process.exit(1);
}

// 2) Backup (read-only) BEFORE any delete: full contact rows + their enrollments.
const contactsSnap = await sql(`select * from contacts where ${WHERE} order by email`);
const enrollSnap = await sql(`
  select * from campaign_enrollments
  where contact_id in (select id from contacts where ${WHERE})
`);
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(BACKUP_DIR, `noname-contacts-delete-backup-${stamp}.json`);
writeFileSync(backupPath, JSON.stringify({
  taken_at: new Date().toISOString(),
  project: PROJECT_REF,
  campaign_id: CAMPAIGN_ID,
  client_id: CLIENT_ID,
  note: "Snapshot before deleting no-first-name contacts. Restore = re-insert contacts then enrollments.",
  contact_count: contactsSnap.length,
  enrollment_count: enrollSnap.length,
  contacts: contactsSnap,
  enrollments: enrollSnap,
}, null, 2), "utf8");
const reparsed = JSON.parse(readFileSync(backupPath, "utf8"));
if (reparsed.contact_count !== contactsSnap.length) {
  console.error("Backup sanity check failed. Aborting.");
  process.exit(1);
}
console.log(`Backup written + verified: ${backupPath}`);
console.log(`  contacts snapshotted   : ${reparsed.contact_count}`);
console.log(`  enrollments snapshotted: ${reparsed.enrollment_count}\n`);

if (!APPLY) {
  console.log("DRY RUN complete. No database changes made. Re-run with --apply to delete.");
  process.exit(0);
}

// 3) Delete (cascades to enrollments/sends/enrichment_items/manual_tasks).
const deleted = await sql(`delete from contacts where ${WHERE} returning id`);
console.log(`DELETE complete: ${deleted.length} contacts removed (enrollments cascade-deleted)\n`);

// 4) Verify
const [after] = await sql(`
  select
    (select count(*) from contacts where ${WHERE}) as remaining_noname,
    (select count(*) from contacts where campaign_id='${CAMPAIGN_ID}') as assigned_now,
    (select count(*) from campaign_enrollments where campaign_id='${CAMPAIGN_ID}') as enrolled_now
`);
console.log("Post-op verify:");
console.log(`  no-first-name remaining : ${after.remaining_noname} (expected 0)`);
console.log(`  campaign assigned       : ${after.assigned_now} (expected ${Number(state.assigned_now) - Number(state.to_delete)})`);
console.log(`  campaign enrolled       : ${after.enrolled_now} (expected ${Number(state.enrolled_now) - Number(state.to_delete)})`);
const ok =
  Number(after.remaining_noname) === 0 &&
  Number(after.assigned_now) === Number(state.assigned_now) - Number(state.to_delete) &&
  Number(after.enrolled_now) === Number(state.enrolled_now) - Number(state.to_delete);
console.log(ok ? "\nRECONCILED ✓" : "\nMISMATCH — investigate; backup is the rollback path.");
process.exit(ok ? 0 : 1);
