#!/usr/bin/env node
/**
 * Read-only probe of the Spaceship API against the org's real key. Prints the
 * RAW HTTP status + body for the three GET endpoints the registrar client
 * parses, so one run pins the response shapes the code marks PENDING LIVE
 * VERIFICATION:
 *   - availability price field  (src/lib/registrar/spaceship.ts extractRegistrationPrice)
 *   - saved-contacts list + id  (firstContactId)
 *   - DNS records read-back     (getDnsRecords / upsertDnsRecords merge)
 *
 * GET-only: no domain is registered, no DNS is written, no money is spent. The
 * key is read from the DB and NEVER printed. After a run, reconcile the printed
 * JSON with the parsers and drop the PENDING markers.
 *
 * Usage:
 *   npx tsx scripts/probe-spaceship.ts [availabilityDomain] [ownedDomainForDnsRead]
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}

const BASE = "https://spaceship.dev/api/v1";
const availabilityDomain = process.argv[2] ?? `ls-probe-${Date.now()}.com`;
const ownedDomain = process.argv[3] ?? null;

async function main() {
  const env = loadEnvLocal();
  const admin = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: org } = await admin
    .from("organizations")
    .select("id, spaceship_api_key, spaceship_api_secret")
    .not("spaceship_api_key", "is", null)
    .limit(1)
    .maybeSingle();

  if (!org?.spaceship_api_key || !org?.spaceship_api_secret) {
    console.log(
      "No Spaceship API key configured on any org. Add it in Settings, Integrations first.",
    );
    process.exit(0);
  }
  console.log(`Using Spaceship key on org ${org.id} (secret not shown).`);

  const headers = {
    "X-Api-Key": org.spaceship_api_key as string,
    "X-Api-Secret": org.spaceship_api_secret as string,
    "Content-Type": "application/json",
  };

  async function get(label: string, path: string) {
    console.log(`\n=== ${label} ===`);
    console.log(`GET ${path}`);
    try {
      const res = await fetch(`${BASE}${path}`, { headers });
      const text = await res.text();
      console.log(`HTTP ${res.status}`);
      console.log(text.slice(0, 4000));
    } catch (err) {
      console.log(`FETCH ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await get(
    `availability (${availabilityDomain})`,
    `/domains/${encodeURIComponent(availabilityDomain)}/available`,
  );
  await get("saved contacts", `/contacts?take=50&skip=0`);
  if (ownedDomain) {
    await get(
      `dns records (${ownedDomain})`,
      `/dns/records/${encodeURIComponent(ownedDomain)}?take=100&skip=0`,
    );
  } else {
    console.log(
      "\n(Pass an owned domain as arg 2 to also probe the DNS read-back shape.)",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
