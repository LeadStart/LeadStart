/**
 * Prune David Cabrera's campaign down to MillionVerifier-verified emails only.
 *
 *   node scripts/prune-david-cabrera-unverified.mjs            # dry run (no writes)
 *   node scripts/prune-david-cabrera-unverified.mjs --apply    # delete unverified
 *   node scripts/prune-david-cabrera-unverified.mjs --csv "<path>"
 *
 * The verified CSV (…_OK_ONLY_MILLIONVERIFIER.COM.csv) is the keep-list. Any
 * contact currently enrolled in the campaign whose email is NOT in that list
 * gets its enrollment AND its contact row deleted (they were created solely
 * for this campaign, are unverified, and would bounce). Nothing else is
 * touched. Dry run reports the exact keep/remove split before any writes.
 */
import { readFileSync } from "node:fs";

const ORG_ID = "bfc96611-8b2f-49c2-b4e0-49ebadc295e1";
const CAMPAIGN_ID = "f9c179e6-799d-44f4-8753-806fcc1c2b83";
const IMPORT_SOURCE = "csv-import-david-cabrera"; // safety scope for deletes

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
if (!URL || !KEY) { console.error("Missing Supabase env"); process.exit(1); }

async function rest(method, path, { body, prefer } = {}) {
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers["Prefer"] = prefer;
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
  return json;
}
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

function parseCSV(text) {
  const rows = []; let row = [], field = "", inQ = false, i = 0;
  const s = text.replace(/^﻿/, "");
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; }
      else { field += c; i++; }
    } else if (c === '"') { inQ = true; i++; }
    else if (c === ",") { row.push(field); field = ""; i++; }
    else if (c === "\n" || c === "\r") { row.push(field); field = ""; if (!(row.length === 1 && row[0] === "")) rows.push(row); row = []; if (c === "\r" && s[i + 1] === "\n") i += 2; else i++; }
    else { field += c; i++; }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const csvArgIdx = args.indexOf("--csv");
const CSV_PATH = csvArgIdx >= 0 ? args[csvArgIdx + 1]
  : "C:\\Users\\danie\\Downloads\\Buyer Agent Information - Sheet2_OK_ONLY_MILLIONVERIFIER.COM.csv";

console.log(`Mode: ${APPLY ? "APPLY (deleting unverified)" : "DRY RUN (no writes)"}`);
console.log(`Verified CSV: ${CSV_PATH}\n`);

// 1) Build the verified keep-set from the CSV email column.
const grid = parseCSV(readFileSync(CSV_PATH, "utf8"));
const header = grid[0].map((h) => h.trim().toLowerCase());
const emailIdx = header.findIndex((h) => h.includes("email"));
if (emailIdx < 0) { console.error("No email column in verified CSV"); process.exit(1); }
const verified = new Set();
for (let r = 1; r < grid.length; r++) {
  const e = (grid[r][emailIdx] ?? "").trim().toLowerCase();
  if (e && e.includes("@")) verified.add(e);
}
console.log(`Verified-good emails in CSV: ${verified.size} unique (${grid.length - 1} rows)\n`);

// 2) Fetch all contacts enrolled in the campaign (id + email).
const enr = await rest("GET", `campaign_enrollments?campaign_id=eq.${CAMPAIGN_ID}&select=id,contact_id`);
const contactIds = enr.map((e) => e.contact_id);
const contacts = [];
for (const c of chunk(contactIds, 150)) {
  const inList = c.map((id) => `"${id}"`).join(",");
  const rows = await rest("GET", `contacts?id=in.(${inList})&select=id,email,source`);
  contacts.push(...rows);
}
console.log(`Campaign currently has ${enr.length} enrollments across ${contacts.length} contacts.\n`);

// 3) Split keep vs remove.
const keep = [], remove = [];
for (const c of contacts) {
  const e = (c.email ?? "").trim().toLowerCase();
  if (e && verified.has(e)) keep.push(c);
  else remove.push(c);
}
// Verified emails that aren't in the campaign at all (were skipped at import
// as dups / missing name). Informational only — we don't re-add here.
const inCampaign = new Set(contacts.map((c) => (c.email ?? "").toLowerCase()));
const verifiedNotInCampaign = [...verified].filter((e) => !inCampaign.has(e));

console.log(`KEEP:   ${keep.length} contacts (verified)`);
console.log(`REMOVE: ${remove.length} contacts (not in verified list)`);
console.log(`Verified emails not currently in the campaign: ${verifiedNotInCampaign.length}`);
if (remove.length) {
  console.log(`  sample to remove: ${remove.slice(0, 8).map((c) => c.email).join(", ")}`);
}
// Safety: every contact we would delete must carry the import source tag.
const unsafe = remove.filter((c) => c.source !== IMPORT_SOURCE);
if (unsafe.length) {
  console.log(`\n⚠ ${unsafe.length} remove-candidates are NOT source='${IMPORT_SOURCE}' — they will be UN-ENROLLED but their contact row kept:`);
  console.log(`  ${unsafe.slice(0, 8).map((c) => c.email).join(", ")}`);
}
console.log();

if (!APPLY) {
  console.log("DRY RUN complete. No changes. Re-run with --apply to delete.");
  process.exit(0);
}

// ============================ APPLY ============================
const removeIds = remove.map((c) => c.id);
const removeContactIds = remove.filter((c) => c.source === IMPORT_SOURCE).map((c) => c.id);

// 4) Delete enrollments for all remove contacts (child rows first).
let delEnr = 0;
for (const c of chunk(removeIds, 100)) {
  const inList = c.map((id) => `"${id}"`).join(",");
  await rest("DELETE", `campaign_enrollments?campaign_id=eq.${CAMPAIGN_ID}&contact_id=in.(${inList})`, { prefer: "return=minimal" });
  delEnr += c.length;
  console.log(`  deleted enrollments ${delEnr}/${removeIds.length}`);
}

// 5) Delete the contact rows (scoped to the import source for safety).
let delC = 0;
for (const c of chunk(removeContactIds, 100)) {
  const inList = c.map((id) => `"${id}"`).join(",");
  await rest("DELETE", `contacts?organization_id=eq.${ORG_ID}&source=eq.${IMPORT_SOURCE}&id=in.(${inList})`, { prefer: "return=minimal" });
  delC += c.length;
  console.log(`  deleted contacts ${delC}/${removeContactIds.length}`);
}

console.log(`\nDONE. Removed ${removeIds.length} enrollments + ${removeContactIds.length} contacts.`);
console.log(`Campaign now targets ${keep.length} verified contacts.`);
