/**
 * Run arbitrary SQL against the Supabase project via the Management API.
 *
 *   node scripts/supabase-sql.mjs "<SQL>"
 *   node scripts/supabase-sql.mjs --file path/to/file.sql
 *
 * Uses SUPABASE_ACCESS_TOKEN + project ref from NEXT_PUBLIC_SUPABASE_URL (.env.local).
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

const [arg0, arg1] = process.argv.slice(2);
let sql;
if (arg0 === "--file") {
  sql = readFileSync(arg1, "utf8");
} else if (arg0) {
  sql = arg0;
} else {
  console.error("Usage: node scripts/supabase-sql.mjs \"<SQL>\"  OR  --file path/to/file.sql");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: sql }),
});
const body = await res.text();
let json;
try { json = JSON.parse(body); } catch { json = body; }

console.log(`Status: ${res.status}`);
console.log(typeof json === "string" ? json : JSON.stringify(json, null, 2));
if (!res.ok) process.exit(1);
