#!/usr/bin/env node
/**
 * Gazetteer lookup test against the seeded geo_places table — exercises the exact
 * per-kind prefix query the geo-typeahead endpoint runs, and asserts the
 * confirmatory disambiguation works on REAL Census data. Read-only, no spend, no
 * mutation. Run: npx tsx scripts/e2e-geo-typeahead.ts
 *
 * (The HANDOFF's "Dallas→3 counties / Springfield→3 states" were illustrative;
 * the real data is 5 and 16 — asserted below as ≥3 with the key states present.)
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
const env = loadEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}

type Row = { kind: string; name: string; state_code: string | null; state_name: string | null };
const PER_KIND = 8;

// Mirror the endpoint: one capped prefix query per requested kind.
async function typeahead(q: string, kinds: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const kind of kinds) {
    const { data } = await admin
      .from("geo_places")
      .select("kind, name, state_code, state_name")
      .eq("kind", kind)
      .ilike("name", `${q}%`)
      .order("name", { ascending: true })
      .order("state_code", { ascending: true })
      .limit(PER_KIND);
    out.push(...((data as Row[] | null) ?? []));
  }
  return out;
}
// Same wider query the disambiguation counts assert against (no per-kind cap).
async function allOfKind(q: string, kind: string): Promise<Row[]> {
  const { data } = await admin
    .from("geo_places")
    .select("kind, name, state_code, state_name")
    .eq("kind", kind)
    .ilike("name", q)
    .limit(200);
  return (data as Row[] | null) ?? [];
}

async function main() {
  console.log("seed sanity");
  const { count: total } = await admin.from("geo_places").select("id", { count: "exact", head: true });
  ok((total ?? 0) > 22000, `geo_places seeded (${total} rows)`);

  console.log("Dallas → counties across states (confirmatory disambiguation)");
  const dallas = await allOfKind("Dallas County", "county");
  const dallasStates = new Set(dallas.map((r) => r.state_code));
  ok(dallasStates.size >= 3, `"Dallas County" spans ≥3 states (got ${dallasStates.size}: ${[...dallasStates].sort().join(",")})`);
  ok(dallasStates.has("TX"), "Dallas County, TX is present");

  console.log("Springfield → cities across states");
  const spring = await allOfKind("Springfield", "city");
  const springStates = new Set(spring.map((r) => r.state_code));
  ok(springStates.size >= 3, `"Springfield" city spans ≥3 states (got ${springStates.size})`);
  ok(springStates.has("IL"), "Springfield, IL is present");
  ok(springStates.has("MO"), "Springfield, MO is present");

  console.log("state prefix match");
  const tex = await typeahead("tex", ["state"]);
  ok(tex.some((r) => r.name === "Texas"), "'tex' → Texas (state)");
  ok(tex.every((r) => r.kind === "state"), "kind filter honored — only states returned");

  console.log("city prefix match + label shape");
  const austin = await typeahead("Austin", ["city"]);
  const austinTx = austin.find((r) => r.state_code === "TX");
  ok(!!austinTx, "Austin, TX present in city results");
  ok(austinTx?.state_name === "Texas", "city row carries full state_name for the label", austinTx);

  console.log("mixed-kind balanced query");
  const mixed = await typeahead("Dallas", ["city", "county", "state"]);
  ok(mixed.some((r) => r.kind === "county"), "mixed 'Dallas' includes a county");
  ok(mixed.some((r) => r.kind === "city"), "mixed 'Dallas' includes a city");
  ok(mixed.filter((r) => r.kind === "city").length <= PER_KIND, "per-kind cap honored (≤8 cities)");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
