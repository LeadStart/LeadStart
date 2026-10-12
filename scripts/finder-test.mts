// The pay-per-hit email-finder test (owner go 2026-10-12): the same 200 owners
// through Enrow, Icypeas, Datagma and Findymail, so hits, cost and bounces can
// be compared on this exact audience instead of vendor benchmarks.
//
//   npx tsx --tsconfig scripts/tsconfig.harness.json scripts/finder-test.mts [--dry-run]
//   npx tsx --tsconfig scripts/tsconfig.harness.json scripts/finder-test.mts --provider enrow --go
//   npx tsx --tsconfig scripts/tsconfig.harness.json scripts/finder-test.mts --verify --go
//   npx tsx --tsconfig scripts/tsconfig.harness.json scripts/finder-test.mts --report
//
// Run from the LeadStart repo root. Credentials are read in-process from the
// main checkout's .env.local (service key) and the org row (finder keys), the
// way the tube-pipeline scripts do, and are never printed. Nothing here writes
// to contacts; every result lands in ~/Downloads/finder-test/ (prospect data,
// kept outside the repo).
//
// Steps:
//   (default / --dry-run)  draw (or re-read) the 200-person sample and print
//                          what each provider WOULD be sent, with counts and
//                          an estimated cost. No provider call.
//   --provider <p> --go    pass 1: name + domain through <p>'s single-lookup
//                          endpoint; pass 2 (Enrow, Findymail only): LinkedIn
//                          URL on pass-1 misses. Balance read before and after
//                          where the provider has one, so real debits are
//                          measured. Results append to results-<p>.jsonl.
//   --verify --go          every returned address through the app's Million
//                          Verifier client (1 credit per definitive verdict;
//                          the count is printed first). Appends to verify.jsonl.
//   --report               the comparison table from the files above.
//
// Sample: seeded (20261013), stratified: 46 owners with an MV-ok email (the
// ground truth for accuracy) + 154 with no usable owner email (incremental
// coverage), all with a company domain and a LinkedIn URL, drawn from the
// national import (tag saasassins-li-2026-10). The sampler is pure and tested
// (scripts/test-finders.ts).

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { ORG_ID, args, assertRepoCwd, importRepo, loadEnvIntoProcess, main, rest } from "../.claude/skills/tube-pipeline/scripts/lib.mjs";
import { stratifiedSample } from "./finder-test-sample.ts";

const OUT = join(os.homedir(), "Downloads", "finder-test");
const SAMPLE = join(OUT, "sample.json");
const SEED = 20261013;
const SIZES = { known: 46, misses: 154 };
const BATCH_TAG = "saasassins-li-2026-10";
const PROVIDERS = ["enrow", "icypeas", "datagma", "findymail"] as const;
type Provider = (typeof PROVIDERS)[number];

// Entry-tier list prices from docs/audits/2026-10-12-email-finder-research.md
// (estimates for the dry run; the real cost comes from the balance readings).
const PRICE_PER_HIT: Record<Provider, number> = { enrow: 0.017, icypeas: 0.019, datagma: 0.0163, findymail: 0.049 };
const LINKEDIN_PASS: Record<Provider, boolean> = { enrow: true, icypeas: false, datagma: false, findymail: true };

type Person = {
  id: string;
  first_name: string;
  last_name: string;
  company_name: string;
  company_domain: string;
  linkedin_url: string;
  known_email: string | null; // the MV-ok owner email we already hold, else null
  stratum: "known" | "miss";
};
type ResultRow = {
  at: string;
  provider: Provider;
  pass: 1 | 2;
  contact_id: string;
  stratum: "known" | "miss";
  status: string; // found | catch_all | not_found | pending | error
  email: string | null;
  provider_status: string | null;
  credits_reported: number | null;
  same_domain: boolean | null;
  free_mail: boolean | null;
  matches_known: boolean | null;
  error: string | null;
};

const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|proton|protonmail)\./i;
const bare = (d: string) => (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const domainOf = (e: string | null) => (e ? bare(e.split("@")[1] ?? "") : "");
const readLines = (file: string): ResultRow[] =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ResultRow) : [];

async function drawSample(): Promise<Person[]> {
  if (existsSync(SAMPLE)) return JSON.parse(readFileSync(SAMPLE, "utf8")) as Person[];
  // Every imported owner with both inputs; a usable owner email = a personal
  // (not company_generic) address that Million Verifier marked ok.
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const page = await rest(
      `contacts?organization_id=eq.${ORG_ID}&tags=cs.{${BATCH_TAG}}&company_domain=not.is.null&linkedin_url=not.is.null` +
        `&select=id,first_name,last_name,company_name,company_domain,linkedin_url,email,email_verification_status,email_kind:enrichment_data->enrichment->email->>kind&order=id`,
      { headers: { Range: `${from}-${from + 999}` } },
    );
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const people: Person[] = rows
    .filter((r) => String(r.first_name ?? "").trim() && String(r.last_name ?? "").trim())
    .map((r) => {
      const email = typeof r.email === "string" ? r.email : null;
      const ok = !!email && r.email_verification_status === "ok" && r.email_kind !== "company_generic";
      const usable = !!email && r.email_kind !== "company_generic" && ["ok", "catch_all"].includes(String(r.email_verification_status));
      return {
        id: String(r.id),
        first_name: String(r.first_name).trim(),
        last_name: String(r.last_name).trim(),
        company_name: String(r.company_name ?? "").trim(),
        company_domain: bare(String(r.company_domain)),
        linkedin_url: String(r.linkedin_url),
        known_email: ok ? email : null,
        stratum: usable ? "known" : "miss",
      } as Person;
    })
    // the "known" stratum is MV-ok only (ground truth); catch-all holders are neither
    .filter((p) => p.stratum === "miss" || p.known_email);
  const sample = stratifiedSample(people, (p) => p.stratum === "known", SIZES, SEED);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(SAMPLE, JSON.stringify(sample, null, 1));
  console.log(`sample drawn from ${people.length} eligible owners → ${SAMPLE}`);
  return sample;
}

function describe(sample: Person[]) {
  const known = sample.filter((p) => p.stratum === "known").length;
  console.log(`sample: ${sample.length} owners = ${known} with a verified owner email (ground truth) + ${sample.length - known} without one`);
  const hosts: Record<string, number> = {};
  for (const p of sample) hosts[p.company_domain.split(".").pop() ?? "?"] = (hosts[p.company_domain.split(".").pop() ?? "?"] ?? 0) + 1;
  console.log("  domains by TLD:", Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(" · "));
}

async function finderKeys(): Promise<Record<Provider, string | null>> {
  // The three new columns arrive with migration 00139; until it is applied the
  // select would fail, so a dry run before the migration still shows the plan.
  let org: Record<string, string | null> | undefined;
  try {
    [org] = await rest(`organizations?id=eq.${ORG_ID}&select=enrow_api_key,icypeas_api_key,datagma_api_key,findymail_api_key`);
  } catch (e) {
    console.log(`  (finder key columns not readable yet: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}; apply migration 00139 first)`);
    [org] = await rest(`organizations?id=eq.${ORG_ID}&select=findymail_api_key`);
  }
  return {
    enrow: org?.enrow_api_key ?? null,
    icypeas: org?.icypeas_api_key ?? null,
    datagma: org?.datagma_api_key ?? null,
    findymail: org?.findymail_api_key ?? null,
  };
}

async function runProvider(provider: Provider, sample: Person[], go: boolean) {
  const keys = await finderKeys();
  const file = join(OUT, `results-${provider}.jsonl`);
  const done = new Set(readLines(file).filter((r) => r.pass === 1 && r.status !== "error" && r.status !== "pending").map((r) => r.contact_id));
  const todo = sample.filter((p) => !done.has(p.id));
  const pass2 = LINKEDIN_PASS[provider];
  console.log(`\n${provider}: key ${keys[provider] ? "set" : "MISSING"} · pass 1 (name + domain) on ${todo.length} of ${sample.length}${pass2 ? " · pass 2 (LinkedIn URL) on pass-1 misses" : " · no LinkedIn pass"}`);
  console.log(`  estimated cost if every lookup hit: $${(todo.length * PRICE_PER_HIT[provider]).toFixed(2)} (misses are free${provider === "enrow" ? "; an Enrow LinkedIn miss is 0.25 credit" : ""})`);
  if (!go) {
    console.log("  DRY RUN: no provider called. Add --go to run.");
    return;
  }
  if (!keys[provider]) throw new Error(`${provider}: no API key saved (Settings → API → Email finders).`);
  if (todo.length === 0) {
    console.log("  nothing left to do for pass 1");
  }

  const { EnrowClient } = await importRepo("src/lib/finders/enrow.ts");
  const { IcypeasClient } = await importRepo("src/lib/finders/icypeas.ts");
  const { DatagmaClient } = await importRepo("src/lib/finders/datagma.ts");
  const { FindymailClient } = await importRepo("src/lib/findymail/client.ts");
  const key = keys[provider] as string;

  // Balance before, where the provider reports one.
  const balance = async (): Promise<number | null> => {
    try {
      if (provider === "enrow") return await new EnrowClient(key).remainingCredits();
      if (provider === "datagma") return await new DatagmaClient(key).remainingCredits();
      if (provider === "findymail") return await new FindymailClient(key).remainingCredits();
    } catch (e) {
      console.log(`  (balance read failed: ${e instanceof Error ? e.message : String(e)})`);
    }
    return null;
  };
  const before = await balance();
  console.log(`  balance before: ${before ?? "not reported"}`);

  const row = (p: Person, pass: 1 | 2, r: { status: string; email: string | null; provider_status: string | null; credits_reported: number | null }, error: string | null = null): ResultRow => ({
    at: new Date().toISOString(),
    provider,
    pass,
    contact_id: p.id,
    stratum: p.stratum,
    status: r.status,
    email: r.email,
    provider_status: r.provider_status,
    credits_reported: r.credits_reported,
    same_domain: r.email ? domainOf(r.email) === p.company_domain : null,
    free_mail: r.email ? FREE_MAIL.test(r.email) : null,
    matches_known: r.email && p.known_email ? r.email.toLowerCase() === p.known_email.toLowerCase() : null,
    error,
  });

  let hits = 0, misses = 0, errors = 0, stop = false;
  const lookup1 = async (p: Person) => {
    const full = `${p.first_name} ${p.last_name}`;
    if (provider === "enrow") return new EnrowClient(key).findByNameDomain(full, p.company_domain);
    if (provider === "icypeas") return new IcypeasClient(key).findByNameDomain(p.first_name, p.last_name, p.company_domain, { externalId: p.id });
    if (provider === "datagma") return new DatagmaClient(key).findByNameDomain(full, p.company_domain);
    const fm = await new FindymailClient(key).findByNameDomain(full, p.company_domain);
    return { status: fm.found ? "found" : "not_found", email: fm.email, provider_status: fm.found ? "found" : "not_found", credits_reported: fm.found ? 1 : 0 };
  };
  const lookup2 = async (p: Person) => {
    if (provider === "enrow") return new EnrowClient(key).findByLinkedInUrl(p.linkedin_url);
    // Findymail documents a business-profile finder; its contract was not
    // verified against a live account (client.ts header), so pass 2 is Enrow-only
    // until it is. Recorded as a skip, not a miss.
    return { status: "not_found", email: null, provider_status: "skipped: no verified LinkedIn-URL endpoint", credits_reported: 0 };
  };

  for (const p of todo) {
    if (stop) break;
    try {
      const r1 = await lookup1(p);
      appendFileSync(file, JSON.stringify(row(p, 1, r1)) + "\n");
      if (r1.status === "found" || r1.status === "catch_all") hits++;
      else misses++;
      if (r1.status === "not_found" && pass2 && provider === "enrow") {
        const r2 = await lookup2(p);
        appendFileSync(file, JSON.stringify(row(p, 2, r2)) + "\n");
        if (r2.status === "found" || r2.status === "catch_all") hits++;
      }
    } catch (e: unknown) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      appendFileSync(file, JSON.stringify(row(p, 1, { status: "error", email: null, provider_status: null, credits_reported: null }, msg)) + "\n");
      const definitive = e instanceof Error && e.name === "FinderError" && (e as { definitive?: boolean }).definitive === true;
      if (definitive) {
        console.log(`  STOP: ${msg}`);
        stop = true;
      } else if (/credits|auth/i.test(msg) && provider === "findymail") {
        console.log(`  STOP: ${msg}`);
        stop = true;
      }
    }
    if ((hits + misses + errors) % 25 === 0) console.log(`  ${hits + misses + errors}/${todo.length} · hits ${hits} · misses ${misses} · errors ${errors}`);
  }
  const after = await balance();
  console.log(`  done · hits ${hits} · misses ${misses} · errors ${errors} · balance after: ${after ?? "not reported"}${before != null && after != null ? ` · DEBITED ${before - after} credits` : ""}`);
  console.log(`  results → ${file}`);
}

async function verifyAll(go: boolean) {
  const { MillionVerifierClient } = await importRepo("src/lib/millionverifier/client.ts");
  const [org] = await rest(`organizations?id=eq.${ORG_ID}&select=millionverifier_api_key`);
  const key = org?.millionverifier_api_key || process.env.MILLIONVERIFIER_API_KEY || "";
  const vfile = join(OUT, "verify.jsonl");
  const already = new Set(existsSync(vfile) ? readFileSync(vfile, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { email: string }).email.toLowerCase()) : []);
  const emails = new Map<string, Provider[]>();
  for (const prov of PROVIDERS) for (const r of readLines(join(OUT, `results-${prov}.jsonl`))) {
    if (!r.email) continue;
    const e = r.email.toLowerCase();
    if (already.has(e)) continue;
    emails.set(e, [...(emails.get(e) ?? []), prov]);
  }
  console.log(`\nverify: ${emails.size} distinct returned addresses not yet checked (at most ${emails.size} Million Verifier credits; catch-all/unknown answers are free)`);
  if (!go) {
    console.log("  DRY RUN: nothing sent. Add --go to verify.");
    return;
  }
  if (!key) throw new Error("no Million Verifier key");
  const client = new MillionVerifierClient(key);
  let n = 0;
  for (const [email, provs] of emails) {
    try {
      const res = await client.verify(email, { timeoutSec: 20 });
      appendFileSync(vfile, JSON.stringify({ at: new Date().toISOString(), email, providers: provs, result: res.result, subresult: res.subresult, free: res.free, role: res.role }) + "\n");
    } catch (e) {
      appendFileSync(vfile, JSON.stringify({ at: new Date().toISOString(), email, providers: provs, result: "error", error: e instanceof Error ? e.message : String(e) }) + "\n");
    }
    if (++n % 25 === 0) console.log(`  ${n}/${emails.size}`);
  }
  console.log(`  done → ${vfile}`);
}

function report(sample: Person[]) {
  const verdict = new Map<string, string>();
  const vfile = join(OUT, "verify.jsonl");
  if (existsSync(vfile)) for (const l of readFileSync(vfile, "utf8").trim().split("\n").filter(Boolean)) { const v = JSON.parse(l) as { email: string; result: string }; verdict.set(v.email.toLowerCase(), v.result); }
  const known = sample.filter((p) => p.stratum === "known").length, miss = sample.length - known;
  const perProv: Record<string, { hits: number; mvOk: number; mvCatch: number; mvBad: number; unverified: number; wrongDomain: number; freeMail: number; knownHits: number; knownMatch: number; missHits: number; errors: number; credits: number; set: Set<string> }> = {};
  for (const prov of PROVIDERS) {
    const rows = readLines(join(OUT, `results-${prov}.jsonl`));
    if (!rows.length) continue;
    const s = (perProv[prov] = { hits: 0, mvOk: 0, mvCatch: 0, mvBad: 0, unverified: 0, wrongDomain: 0, freeMail: 0, knownHits: 0, knownMatch: 0, missHits: 0, errors: 0, credits: 0, set: new Set<string>() });
    for (const r of rows) {
      if (r.status === "error") { s.errors++; continue; }
      s.credits += r.credits_reported ?? 0;
      if (!r.email) continue;
      s.hits++; s.set.add(r.contact_id);
      const v = verdict.get(r.email.toLowerCase());
      if (v === "ok") s.mvOk++; else if (v === "catch_all") s.mvCatch++; else if (v) s.mvBad++; else s.unverified++;
      if (r.same_domain === false) s.wrongDomain++;
      if (r.free_mail) s.freeMail++;
      if (r.stratum === "known") { s.knownHits++; if (r.matches_known) s.knownMatch++; } else s.missHits++;
    }
  }
  const provs = Object.keys(perProv) as Provider[];
  if (!provs.length) { console.log("no results yet"); return; }
  console.log(`\nFinder test · ${sample.length} owners (${known} known + ${miss} misses) · MV verdicts: ${verdict.size}\n`);
  console.log("| Provider | Hits | MV ok | MV catch-all | MV bad | Unverified | Wrong domain | Free-mail | Accuracy on known | New on misses | Errors | Credits (reported) | Est. $ | $ per MV-ok |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const prov of provs) {
    const s = perProv[prov]; const usd = s.credits * PRICE_PER_HIT[prov];
    console.log(`| ${prov} | ${s.hits} | ${s.mvOk} | ${s.mvCatch} | ${s.mvBad} | ${s.unverified} | ${s.wrongDomain} | ${s.freeMail} | ${s.knownMatch}/${s.knownHits} | ${s.missHits}/${miss} | ${s.errors} | ${s.credits} | $${usd.toFixed(2)} | ${s.mvOk ? "$" + (usd / s.mvOk).toFixed(3) : "-"} |`);
  }
  if (provs.length > 1) {
    console.log("\nOverlap (people both found):");
    for (let i = 0; i < provs.length; i++) for (let j = i + 1; j < provs.length; j++) {
      const a = perProv[provs[i]].set, b = perProv[provs[j]].set;
      console.log(`  ${provs[i]} ∩ ${provs[j]}: ${[...a].filter((x) => b.has(x)).length} · only ${provs[i]}: ${[...a].filter((x) => !b.has(x)).length} · only ${provs[j]}: ${[...b].filter((x) => !a.has(x)).length}`);
    }
  }
  console.log("\nEst. $ uses entry-tier list prices; the balance readings printed by each run are the real debits. Hard bounces come from the first real send, not from here.");
}

// lib.mjs's args() is untyped (the skill scripts sit outside tsconfig's
// `include`; this one does not), so narrow it here.
type Flags = { go?: true; report?: true; verify?: true; "dry-run"?: true; provider?: string | true };

main(async () => {
  assertRepoCwd();
  loadEnvIntoProcess();
  const a = args() as Flags;
  const go = a.go === true;
  if (a.report) { report(await drawSample()); return; }
  if (a.verify) { await verifyAll(go); return; }
  const sample = await drawSample();
  describe(sample);
  if (typeof a.provider === "string") {
    if (!(PROVIDERS as readonly string[]).includes(a.provider)) throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}`);
    await runProvider(a.provider as Provider, sample, go);
    return;
  }
  console.log("\nDRY RUN (no provider called). Per provider:");
  for (const prov of PROVIDERS) await runProvider(prov, sample, false);
});
