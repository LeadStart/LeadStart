/**
 * Read-only probe: check what's in Supabase for contacts/prospects/clients.
 *
 * Usage: node scripts/probe-contacts-prospects.mjs
 *   (reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local)
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
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: "count=exact",
    },
  });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = body; }
  return { status: res.status, contentRange: res.headers.get("content-range"), body: json };
}

function label(name, r) {
  if (r.status === 404) return `  ${name}: TABLE MISSING (404)`;
  if (r.status >= 400) return `  ${name}: ERROR ${r.status} ${JSON.stringify(r.body).slice(0,160)}`;
  const count = r.contentRange?.split("/")[1];
  return `  ${name}: ${Array.isArray(r.body) ? r.body.length : "?"} rows (total: ${count ?? "?"})`;
}

const [orgs, clients, contacts, prospects] = await Promise.all([
  rest("organizations?select=id,name"),
  rest("clients?select=id,name,contact_email,organization_id&limit=100"),
  rest("contacts?select=id,email,first_name,last_name,company_name,client_id&limit=200"),
  rest("prospects?select=id,contact_id,stage&limit=200"),
]);

console.log("=== Supabase state ===\n");
console.log("Organizations:");
if (Array.isArray(orgs.body)) {
  for (const o of orgs.body) console.log(`  ${o.id}  ${o.name}`);
}
console.log("");

console.log("Tables:");
console.log(label("organizations", orgs));
console.log(label("clients", clients));
console.log(label("contacts", contacts));
console.log(label("prospects", prospects));
console.log("");

if (Array.isArray(clients.body) && clients.body.length) {
  console.log("Clients:");
  for (const c of clients.body) {
    console.log(`  ${c.id}  ${c.name}  (${c.contact_email || "no email"})`);
  }
  console.log("");
}

if (Array.isArray(contacts.body) && contacts.body.length) {
  console.log("Sample contacts:");
  for (const c of contacts.body.slice(0, 10)) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
    console.log(`  ${c.email}  (${name || "-"})  company=${c.company_name || "-"}  client=${c.client_id ?? "-"}`);
  }
  console.log("");
}

if (Array.isArray(prospects.body)) {
  console.log(`Prospects: ${prospects.body.length}`);
  if (prospects.body.length) {
    for (const p of prospects.body.slice(0, 10)) {
      console.log(`  ${p.id}  stage=${p.stage}  contact=${p.contact_id}`);
    }
  }
}
