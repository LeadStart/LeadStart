#!/usr/bin/env node
/**
 * Build the compact geo_places seed TSV from the US Census reference files.
 * Reads the county-reference + place-gazetteer files (downloaded to a working
 * dir), strips them to (kind, name, state_code, state_name, fips), drops the
 * Census-Designated-Place noise (FUNCSTAT != 'A' — keep only incorporated
 * municipalities), and writes supabase/seed/geo-places.tsv. States come from the
 * bundled authoritative list. Run once; the TSV is committed as the reproducible
 * seed source (NOT app-bundled — it only feeds seed-geo-places).
 *
 *   npx tsx scripts/build-geo-seed.ts [workingDir]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { US_STATES } from "../src/lib/geo/us-states.ts";

const WORK =
  process.argv[2] ||
  "C:/Users/danie/AppData/Local/Temp/claude/C--Users-danie-Documents-Claude-leadstart/a667d70b-e838-4968-8a0f-3b96bb2f79c3/scratchpad";
const COUNTY_FILE = `${WORK}/national_county2020.txt`;
const PLACE_FILE = `${WORK}/gaz_place/2023_Gaz_place_national.txt`;
const OUT = "supabase/seed/geo-places.tsv";

const NAME_BY_CODE = new Map(US_STATES.map((s) => [s.code, s.name]));
const isRealState = (code: string) => NAME_BY_CODE.has(code);

type Row = { kind: string; name: string; state_code: string; state_name: string; fips: string };
const rows: Row[] = [];
const seen = new Set<string>();
function add(r: Row) {
  const key = `${r.kind}\u0001${r.name.toLowerCase()}\u0001${r.state_code}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push(r);
}

// ── States (authoritative bundled list) ──
for (const s of US_STATES) {
  add({ kind: "state", name: s.name, state_code: s.code, state_name: s.name, fips: s.fips });
}

// ── Counties: STATE|STATEFP|COUNTYFP|COUNTYNS|COUNTYNAME|CLASSFP|FUNCSTAT ──
{
  const lines = readFileSync(COUNTY_FILE, "utf8").split(/\r?\n/);
  let n = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [state, statefp, countyfp, , countyname] = line.split("|");
    if (!state || !isRealState(state) || !countyname) continue;
    add({
      kind: "county",
      name: countyname.trim(),
      state_code: state,
      state_name: NAME_BY_CODE.get(state)!,
      fips: `${statefp}${countyfp}`, // 5-digit county FIPS
    });
    n++;
  }
  console.log(`counties: ${n}`);
}

// ── Cities: USPS \t GEOID \t ANSICODE \t NAME \t LSAD \t FUNCSTAT \t ... ──
// Keep only incorporated municipalities (FUNCSTAT === 'A') — drops the ~13k
// Census Designated Places (unincorporated hamlets) that are pure prospecting
// noise. Strip the trailing LSAD word ("Austin city" → "Austin"; note "Kansas
// City city" → "Kansas City", because only the final LSAD token is removed).
const LSAD_SUFFIX = /\s+(city|town|village|borough|municipality|CDP|comunidad|zona urbana)$/i;
{
  const lines = readFileSync(PLACE_FILE, "utf8").split(/\r?\n/);
  let n = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const usps = cols[0]?.trim();
    const rawName = cols[3]?.trim();
    const funcstat = cols[5]?.trim();
    if (!usps || !isRealState(usps) || !rawName) continue;
    if (funcstat !== "A") continue; // incorporated only
    const name = rawName.replace(LSAD_SUFFIX, "").trim();
    if (!name) continue;
    add({ kind: "city", name, state_code: usps, state_name: NAME_BY_CODE.get(usps)!, fips: "" });
    n++;
  }
  console.log(`cities (incorporated): ${n}`);
}

mkdirSync("supabase/seed", { recursive: true });
const tsv =
  "kind\tname\tstate_code\tstate_name\tfips\n" +
  rows.map((r) => `${r.kind}\t${r.name}\t${r.state_code}\t${r.state_name}\t${r.fips}`).join("\n") +
  "\n";
writeFileSync(OUT, tsv, "utf8");

const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {});
console.log(`\nwrote ${OUT}`);
console.log(`total rows: ${rows.length}`, counts);

// Spot-checks that surface in the run log.
const dallasCounties = rows.filter((r) => r.kind === "county" && r.name.toLowerCase() === "dallas county");
const springfieldCities = rows.filter((r) => r.kind === "city" && r.name.toLowerCase() === "springfield");
console.log(`spot: "Dallas County" in ${dallasCounties.map((r) => r.state_code).join(", ")}`);
console.log(`spot: "Springfield" (city) in ${springfieldCities.length} states: ${springfieldCities.map((r) => r.state_code).join(", ")}`);
const kc = rows.find((r) => r.kind === "city" && r.state_code === "MO" && r.name === "Kansas City");
console.log(`spot: Kansas City, MO parsed correctly → ${kc ? "yes" : "NO (suffix bug)"}`);
