// Read-only: gather prereqs for a controlled prod waterfall e2e.
//   node scripts/diagnostics/enrich-e2e-prereqs.mjs
import { readFileSync } from "node:fs";
function env() {
  const e = {};
  for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) e[m[1]] = m[3];
  }
  return e;
}
const E = env();
const U = E.NEXT_PUBLIC_SUPABASE_URL, K = E.SUPABASE_SERVICE_ROLE_KEY;
async function rest(p) {
  const r = await fetch(`${U}/rest/v1/${p}`, { headers: { apikey: K, Authorization: `Bearer ${K}`, Prefer: "count=exact" } });
  return { status: r.status, count: r.headers.get("content-range"), body: await r.json().catch(() => null) };
}

const orgs = await rest("organizations?select=id,name,enrichment_settings,apify_api_key,millionverifier_api_key");
for (const o of orgs.body || []) {
  console.log(`ORG ${o.id}  "${o.name}"`);
  console.log(`  apify_key: ${o.apify_api_key ? "set" : "MISSING"}   mv_key: ${o.millionverifier_api_key ? "set" : "MISSING"}`);
  console.log(`  enrichment_settings: ${JSON.stringify(o.enrichment_settings)}`);
  const prof = await rest(`profiles?organization_id=eq.${o.id}&select=id,email,role&or=(role.eq.owner,role.eq.va)&limit=3`);
  console.log(`  owner/va users:`);
  for (const p of prof.body || []) console.log(`    ${p.id}  ${p.email}  role=${p.role}`);
  // candidate contacts for the waterfall: no email, has a company_domain
  const cand = await rest(`contacts?organization_id=eq.${o.id}&email=is.null&company_domain=not.is.null&select=id,first_name,last_name,company_domain,phone&limit=5`);
  console.log(`  email-less contacts WITH a company_domain (${(cand.body || []).length} shown of ${cand.count}):`);
  for (const c of cand.body || []) console.log(`    ${c.id}  ${c.first_name} ${c.last_name}  dom=${c.company_domain}  phone=${c.phone ?? "-"}`);
  // active enrichment run?
  const active = await rest(`enrichment_runs?organization_id=eq.${o.id}&status=in.(pending,running)&select=id,phase,status`);
  console.log(`  active runs: ${JSON.stringify(active.body)}`);
  console.log("");
}
