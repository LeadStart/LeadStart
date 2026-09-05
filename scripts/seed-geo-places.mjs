/**
 * Seed geo_places from the committed compact TSV (supabase/seed/geo-places.tsv).
 * Idempotent full reseed: clears the table (nothing else writes it) then bulk
 * inserts every state / county / city row. Public reference data, zero external
 * spend. Run via the service role (bypasses RLS).
 *
 *   node scripts/seed-geo-places.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const lines = readFileSync("supabase/seed/geo-places.tsv", "utf8").split(/\r?\n/);
const header = lines[0].split("\t");
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const rows = [];
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const c = line.split("\t");
  rows.push({
    kind: c[idx.kind],
    name: c[idx.name],
    state_code: c[idx.state_code] || null,
    state_name: c[idx.state_name] || null,
    country_code: "us",
    fips: c[idx.fips] || null,
  });
}
console.log(`parsed ${rows.length} rows from TSV`);

// Clear (full idempotent reseed): geo_places has no other writer.
const { error: delErr } = await admin.from("geo_places").delete().neq("id", -1);
if (delErr) {
  console.error("clear failed:", delErr.message);
  process.exit(1);
}

// Bulk insert in batches.
const BATCH = 1000;
let inserted = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const part = rows.slice(i, i + BATCH);
  const { error } = await admin.from("geo_places").insert(part);
  if (error) {
    console.error(`insert batch @${i} failed:`, error.message);
    process.exit(1);
  }
  inserted += part.length;
  process.stdout.write(`\r  inserted ${inserted}/${rows.length}`);
}
console.log("");

// Verify counts + spot checks.
const { count: total } = await admin.from("geo_places").select("id", { count: "exact", head: true });
for (const k of ["state", "county", "city"]) {
  const { count } = await admin.from("geo_places").select("id", { count: "exact", head: true }).eq("kind", k);
  console.log(`  ${k}: ${count}`);
}
const { data: dallas } = await admin
  .from("geo_places")
  .select("state_code")
  .eq("kind", "county")
  .ilike("name", "Dallas County");
const { data: spring } = await admin
  .from("geo_places")
  .select("state_code")
  .eq("kind", "city")
  .ilike("name", "Springfield");
console.log(`\nTOTAL in geo_places: ${total}`);
console.log(`spot: "Dallas County" counties in ${dallas?.length} states: ${(dallas ?? []).map((r) => r.state_code).sort().join(", ")}`);
console.log(`spot: "Springfield" cities in ${spring?.length} states: ${(spring ?? []).map((r) => r.state_code).sort().join(", ")}`);
process.exit(0);
