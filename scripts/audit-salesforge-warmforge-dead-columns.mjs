/**
 * READ-ONLY audit for the Salesforge/Warmforge dead-column drop (data-op).
 *
 *   node scripts/audit-salesforge-warmforge-dead-columns.mjs
 *
 * Reports, via the Supabase Management API:
 *   1. Which target columns / the salesforge_enrollment_queue table still EXIST
 *      (information_schema — safe to run before AND after the drop).
 *   2. For any still-present column, how many rows hold a NON-NULL value
 *      (i.e. real data that a DROP would destroy).
 *
 * Re-run after the migration to verify every object is gone (Phase 7).
 * This script never writes. Secrets come from .env.local and are never printed.
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
const TOKEN = env.SUPABASE_ACCESS_TOKEN;
if (!URL || !TOKEN) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_ACCESS_TOKEN in .env.local");
  process.exit(1);
}
const projectRef = URL.replace(/^https?:\/\//, "").split(".")[0];

async function runSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = body; }
  if (!res.ok) {
    console.error(`SQL failed (HTTP ${res.status}):`, typeof json === "string" ? json : JSON.stringify(json));
    process.exit(1);
  }
  return json;
}

// Target objects: [table, column] pairs, plus the standalone table.
const COLUMNS = [
  ["organizations", "salesforge_api_key"],
  ["organizations", "salesforge_workspace_id"],
  ["organizations", "salesforge_default_product_id"],
  ["organizations", "warmforge_api_key"],
  ["campaigns", "salesforge_sequence_id"],
  ["campaigns", "salesforge_daily_contact_cap"],
  ["campaigns", "salesforge_default_tags"],
  ["campaigns", "salesforge_custom_var_mapping"],
  ["lead_replies", "salesforge_email_id"],
  ["lead_replies", "salesforge_thread_id"],
  ["lead_replies", "salesforge_mailbox_id"],
  ["contacts", "salesforge_contact_id"],
];
const TABLE = "salesforge_enrollment_queue";

// 1) Existence check (always safe).
const existRows = await runSql(`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema='public'
    AND (table_name, column_name) IN (
      ${COLUMNS.map(([t, c]) => `('${t}','${c}')`).join(",\n      ")}
    )
  ORDER BY table_name, column_name;
`);
const present = new Set(existRows.map((r) => `${r.table_name}.${r.column_name}`));

const tableRows = await runSql(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_name='${TABLE}';
`);
const tableExists = tableRows.length > 0;

console.log("\n=== EXISTENCE (information_schema) ===");
let anyPresent = false;
for (const [t, c] of COLUMNS) {
  const p = present.has(`${t}.${c}`);
  if (p) anyPresent = true;
  console.log(`  ${p ? "PRESENT" : "gone   "}  ${t}.${c}`);
}
console.log(`  ${tableExists ? "PRESENT" : "gone   "}  TABLE ${TABLE}`);

// 2) Non-null data check for still-present columns.
if (anyPresent) {
  const counts = COLUMNS.filter(([t, c]) => present.has(`${t}.${c}`));
  const selects = counts
    .map(([t, c]) => `(SELECT count(*) FROM public.${t} WHERE ${c} IS NOT NULL) AS "${t}.${c}"`)
    .join(",\n    ");
  const totals = `
    (SELECT count(*) FROM public.organizations) AS "_total_organizations",
    (SELECT count(*) FROM public.campaigns) AS "_total_campaigns",
    (SELECT count(*) FROM public.lead_replies) AS "_total_lead_replies",
    (SELECT count(*) FROM public.contacts) AS "_total_contacts"`;
  const queueCount = tableExists
    ? `,\n    (SELECT count(*) FROM public.${TABLE}) AS "_${TABLE}_rows"`
    : "";
  const dataRows = await runSql(`SELECT\n    ${selects},${totals}${queueCount};`);
  const row = dataRows[0] ?? {};
  console.log("\n=== NON-NULL VALUE COUNTS (data a DROP would destroy) ===");
  let dataFound = false;
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_")) continue;
    const n = Number(v);
    if (n > 0) dataFound = true;
    console.log(`  ${n === 0 ? "  0 (clean)" : String(n).padStart(3) + " ⚠ DATA "}  ${k}`);
  }
  console.log("\n=== TABLE TOTALS (context) ===");
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_")) console.log(`  ${String(v).padStart(6)}  ${k.slice(1)}`);
  }
  console.log(
    `\n=== VERDICT ===\n  ${dataFound ? "⚠ SOME COLUMNS HOLD DATA — review before dropping." : "✅ Every target column is 100% NULL and the queue is empty — safe to drop."}`,
  );
} else {
  console.log("\n=== VERDICT ===\n  ✅ All target objects are GONE (post-migration state).");
}
