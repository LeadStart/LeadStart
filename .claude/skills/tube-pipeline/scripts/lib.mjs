// Shared helpers for the tube-pipeline scripts (see ../SKILL.md).
//
// Credentials: LeadStart's Supabase URL + service-role key are read from the
// MAIN checkout's .env.local inside this process and are never printed. A
// worktree has no .env.local, so the main checkout is located through git.
//
// Every HTTP helper throws on a non-2xx answer; a 403/429 throws StopError so a
// script halts instead of mapping a refusal to "0" and carrying on.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import zlib from "node:zlib";

export const HERE = dirname(fileURLToPath(import.meta.url));
// .claude/skills/tube-pipeline/scripts → the LeadStart repo root.
export const REPO = resolve(HERE, "../../../..");
export const ORG_ID = "bfc96611-8b2f-49c2-b4e0-49ebadc295e1"; // LeadStart Agency
export const TUBE_CAMPAIGN = "a23526b3-1858-40b1-9726-3d8a5c952644"; // "TuBe SEO — AI Visibility Launch"
export const TUBE_REPO = process.env.TUBE_REPO || "C:/Users/dtucc/OneDrive/Documents/Claude/SaaSassins/TuBe SEO/source-repo";
export const RUNS_ROOT = process.env.TUBE_PIPELINE_DIR || join(os.homedir(), "Downloads", "tube-pipeline");

// ── credentials ─────────────────────────────────────────────────────────────
function mainCheckout() {
  try {
    const common = execFileSync("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirname(common);
  } catch {
    return REPO;
  }
}
function loadEnv() {
  for (const root of [REPO, mainCheckout()]) {
    const file = join(root, ".env.local");
    if (!existsSync(file)) continue;
    const env = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=("?)(.*)\2\s*$/);
      if (m) env[m[1]] = m[3];
    }
    return env;
  }
  throw new Error(`No .env.local in ${REPO} or its main checkout: the scripts need LeadStart's Supabase URL + service key.`);
}
const ENV = loadEnv();
const SB = ENV.NEXT_PUBLIC_SUPABASE_URL;
const KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) throw new Error(".env.local lacks NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

/** For app modules that read process.env (createAdminClient): copy the
 *  .env.local values in, without overriding anything already set. Never printed. */
export function loadEnvIntoProcess() {
  for (const [k, v] of Object.entries(ENV)) if (process.env[k] === undefined) process.env[k] = v;
}

// LeadStart's TS modules import "@/..." paths, which tsx resolves from the
// tsconfig in the working directory: run every script from the repo root.
export function assertRepoCwd() {
  if (resolve(process.cwd()).toLowerCase() !== REPO.toLowerCase()) {
    throw new Error(`Run this from the LeadStart repo root (${REPO}), e.g. npx tsx .claude/skills/tube-pipeline/scripts/<script>`);
  }
}
export const importRepo = (rel) => import(pathToFileURL(join(REPO, rel)).href);
/** TuBe's own export helpers (displayName, NAME_GENERIC…); null when the TuBe repo isn't on this machine. */
export async function importTube(rel) {
  const file = join(TUBE_REPO, rel);
  return existsSync(file) ? import(pathToFileURL(file).href) : null;
}

// ── Supabase REST ───────────────────────────────────────────────────────────
export class StopError extends Error {}
export async function rest(path, init = {}) {
  const res = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    const msg = `${init.method ?? "GET"} ${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 300)}`;
    if (res.status === 403 || res.status === 429) throw new StopError(`STOPPED (refused/rate-limited): ${msg}`);
    throw new Error(msg);
  }
  return text ? JSON.parse(text) : null;
}
/** Exact row count for a filter (no rows transferred). */
export async function count(path) {
  const res = await fetch(`${SB}/rest/v1/${path}`, {
    method: "HEAD",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "count=exact", Range: "0-0" },
  });
  if (res.status === 403 || res.status === 429) throw new StopError(`STOPPED (refused/rate-limited): HEAD ${path.split("?")[0]} → HTTP ${res.status}`);
  if (!res.ok && res.status !== 416) throw new Error(`HEAD ${path.split("?")[0]} → HTTP ${res.status}`);
  const total = Number(String(res.headers.get("content-range") ?? "").split("/")[1]);
  if (!Number.isFinite(total)) throw new Error(`HEAD ${path.split("?")[0]}: no row count in the answer`);
  return total;
}
/** Every row, paging past PostgREST's 1,000-row cap. */
export async function getAll(path, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const rows = await rest(path, { headers: { Range: `${from}-${from + page - 1}` } });
    out.push(...rows);
    if (rows.length < page) return out;
  }
}
/** A PostgREST in-list; each value quoted and URL-encoded (a "+" in an email must not read as a space). */
export const inList = (xs) => `(${xs.map((x) => `"${encodeURIComponent(String(x))}"`).join(",")})`;
/** getAll over a long value list, in chunks that keep the URL short. `pathFn` gets the in-list. */
export async function getIn(pathFn, values, size = 50) {
  const uniq = [...new Set(values.filter((v) => v != null && v !== ""))];
  const out = [];
  for (let i = 0; i < uniq.length; i += size) out.push(...(await getAll(pathFn(inList(uniq.slice(i, i + size))))));
  return out;
}

// ── CSV ─────────────────────────────────────────────────────────────────────
/** RFC 4180 parse into objects keyed by the (trimmed) header. Quoted commas/newlines survive. */
export function parseCsv(text) {
  const s = String(text).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const [header = [], ...body] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  const keys = header.map((h) => h.trim());
  const out = body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
  out.columns = keys;
  return out;
}
export const readCsv = (file) => parseCsv(readFileSync(file, "utf8"));
/** Every cell quoted, CRLF rows; `rows` are arrays or objects keyed by header. */
export function toCsv(headers, rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(",")];
  for (const r of rows) lines.push((Array.isArray(r) ? r : headers.map((h) => r[h])).map(esc).join(","));
  return lines.join("\r\n") + "\r\n";
}

// ── zip (TuBe's export arrives as a zip) ───────────────────────────────────
/** Extract every file of a zip into outDir (stored or deflated entries). Returns the relative paths. */
export function unzipToDir(zipPath, outDir) {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${zipPath} is not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${zipPath}: damaged central directory`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    const out = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!out) throw new Error(`${zipPath}: entry ${name} uses unsupported compression ${method}`);
    const safe = name.replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..").join("/");
    mkdirSync(dirname(join(outDir, safe)), { recursive: true });
    writeFileSync(join(outDir, safe), out);
    files.push(safe);
  }
  return files;
}

// ── run folder ──────────────────────────────────────────────────────────────
// One folder per batch of firms moving through the pipeline, outside the repo
// (it holds prospect names and emails): <RUNS_ROOT>/<run>/ with run.json as the
// stage ledger every script stamps.
export function runDir(name, { create = false } = {}) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`--run needs a short name (letters, digits, . _ -), got ${JSON.stringify(name ?? null)}`);
  }
  const dir = join(RUNS_ROOT, name);
  if (create) mkdirSync(dir, { recursive: true });
  else if (!existsSync(dir)) throw new Error(`No run folder ${dir}. Start the run with brief.mjs --run ${name} (step 0).`);
  return dir;
}
export function readRun(dir) {
  const f = join(dir, "run.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}
export function saveRun(dir, patch) {
  const run = { ...readRun(dir), ...patch };
  writeFileSync(join(dir, "run.json"), JSON.stringify(run, null, 1));
  return run;
}
export function stamp(dir, stage, facts) {
  const run = readRun(dir);
  run.stages = { ...(run.stages ?? {}), [stage]: { at: new Date().toISOString(), ...facts } };
  writeFileSync(join(dir, "run.json"), JSON.stringify(run, null, 1));
  return run;
}
export function listRuns() {
  if (!existsSync(RUNS_ROOT)) return [];
  return readdirSync(RUNS_ROOT)
    .filter((n) => existsSync(join(RUNS_ROOT, n, "run.json")))
    .map((n) => ({ name: n, dir: join(RUNS_ROOT, n), run: readRun(join(RUNS_ROOT, n)), mtime: statSync(join(RUNS_ROOT, n, "run.json")).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}
/** The enrichment run for a run folder: enrichment.json's run id, or (when it
 *  was queued behind another run) the run holding the contacts this run imported. */
export async function findEnrichmentRun(dir) {
  const enrFile = join(dir, "enrichment.json");
  const enr = existsSync(enrFile) ? JSON.parse(readFileSync(enrFile, "utf8")) : null;
  if (enr?.result?.runId) return enr.result.runId;
  const impFile = join(dir, "source-import.json");
  const imp = existsSync(impFile) ? JSON.parse(readFileSync(impFile, "utf8")) : null;
  const ids = (imp?.insertedIds ?? []).slice(0, 40);
  if (!ids.length) return null;
  const items = await getAll(`enrichment_run_items?select=run_id,created_at&contact_id=in.(${ids.join(",")})&order=created_at.desc`);
  return items[0]?.run_id ?? null;
}
// ── where a run stands (status.mts and assess.mjs share this) ───────────────
export const STEPS = ["Brief", "Pull from Scrap.io", "Review the pull", "Import + enrich", "Integrity + sheet",
  "Upload + scan", "Export + validate", "Into the campaign", "Verify", "Completion assessment"];
/** The run's next step, from its ledger (run.json) and its brief. */
export function nextStep(run, brief) {
  const s = run.stages ?? {};
  if (!brief?.confirmed_at) return "Step 0: brief.mjs --run <name>, ask the owner the 10 questions, save brief.json";
  const sourced = s.source_pull || s.source_review || s.source_import;
  if (!s.upload && !s.source_import) {
    if (!sourced) return "Step 1: source-pull.mjs --run <name> (the plan) → owner's go → --count --go / --pull --go. Leads already in LeadStart? Go to step 4 with --tag/--searches";
    if (s.source_pull && !s.source_review) return "Step 2: source-review.mts --run <name>, then show the owner every dropped firm";
    return "Step 3: source-import.mts --run <name> (dry run → owner's go → --apply)";
  }
  if (s.source_import && !s.enrich_start) return "Step 3: enrich.mts --run <name> (the dry run states the cost against the budget → owner's go → --apply)";
  if (s.enrich_start && !s.enrich_done) return "Step 3: enrichment running: enrich-watch.mjs --run <name> (--follow in the background), then enrich-report.mts";
  const u = s.upload;
  if (!u) return "Step 4: build-upload.mts --run <name>";
  const held = brief.pace?.scan === "hold_until_near_send";
  if (!u.checked_tube) return `Step 4: run tube-check.js on the TuBe admin page, save its output as tube-scanned.json, re-run build-upload.mts${held ? " (can wait until just before the held scan)" : ""}`;
  if (u.to_upload > 0 && !s.scan) {
    if (held) return `Held on purpose (the brief): scan the ${u.to_upload} firms in TuBe about a week before they'd reach Email 1 (assess.mjs shows the date), then step 5 with the owner's go`;
    return `Step 5: upload tube-upload-<run>.csv (${u.to_upload} firms) in TuBe; needs the owner's go (TuBe's estimate ${(u.to_upload * 0.034).toFixed(2)} dollars)`;
  }
  if (u.to_upload > 0 && s.scan) return "Step 5: scan running or done; re-run tube-check.js + build-upload.mts until the upload file is empty, then export";
  if (!s.validate) return `Step 6: export ${(u.tube_batches ?? []).map((b) => `"${b.label}"`).join(", ") || "the batch"} in TuBe (owner's go to download), then validate-export.mjs --zip <file>`;
  if (!s.import) return `Step 7: import-campaign.mts dry run → owner's go → --apply (${s.validate.validated} validated, ${s.validate.held} held)`;
  if (!s.verify) return "Step 8: verify-campaign.mts --run <name>";
  if (s.verify.with_problems) return `Fix: verify found ${s.verify.with_problems} contacts with problems, then re-run verify-campaign.mts`;
  if (!s.assess_final) return "Step 9: assess.mjs --run <name> --final, and give the owner the completion assessment";
  return "Done: the completion assessment is in assessment.md. Held firms (held.csv, TuBe's review list) may be worth a second look.";
}
/** A date `n` weekdays after `from` (the campaign starts new people on weekdays). */
export function addWeekdays(from, n) {
  const d = new Date(from);
  let left = Math.max(0, Math.ceil(n));
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d;
}

export const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 1));
export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
export { existsSync, join, basename, readFileSync, writeFileSync, mkdirSync, readdirSync };

// ── small utilities ─────────────────────────────────────────────────────────
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { out._.push(argv[i]); continue; }
    const k = argv[i].slice(2);
    out[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}
export const csvList = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
export const host = (d) => String(d ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
export const emailDomain = (e) => host(String(e ?? "").split("@")[1] ?? "");
// Personal mailbox providers: two firms on gmail.com are not the same firm.
export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net",
  "protonmail.com", "proton.me", "mail.com", "gmx.com", "zoho.com", "fastmail.com", "q.com", "centurylink.net",
]);
// ── does an email address belong to the person the email greets? ─────────────
// Enrichment sometimes pairs the owner's name with a colleague's or assistant's
// address ("Hey Maria," → tom@…). First run (WA-10, 2026-09-29): 7 of 174.
const NICK = {
  jim: ["james"], jimmy: ["james"], bob: ["robert"], rob: ["robert"], bobby: ["robert"], bill: ["william"], billy: ["william"],
  will: ["william"], rich: ["richard"], rick: ["richard", "frederick"], dick: ["richard"], doug: ["douglas"], steve: ["steven", "stephen"],
  mike: ["michael"], mick: ["michael"], tom: ["thomas"], dan: ["daniel"], danny: ["daniel"], dave: ["david"], chris: ["christopher", "christine", "christina"],
  matt: ["matthew"], pat: ["patrick", "patricia"], ben: ["benjamin"], tony: ["anthony"], joe: ["joseph"], sam: ["samuel", "samantha"],
  ed: ["edward"], ted: ["edward", "theodore"], ken: ["kenneth"], greg: ["gregory"], jeff: ["jeffrey", "jeffery"], liz: ["elizabeth"],
  beth: ["elizabeth"], kate: ["katherine", "kathryn", "catherine"], kathy: ["katherine", "kathryn", "kathleen"], andy: ["andrew"],
  drew: ["andrew"], alex: ["alexander", "alexandra"], nick: ["nicholas"], tim: ["timothy"], jon: ["jonathan"], fred: ["frederick"],
  larry: ["lawrence"], jerry: ["gerald", "jerome"], jack: ["john"], johnny: ["john"], sue: ["susan", "suzanne"], jen: ["jennifer"],
  jenny: ["jennifer"], becky: ["rebecca"], cathy: ["catherine"], patty: ["patricia"], trish: ["patricia"], peggy: ["margaret"],
  meg: ["margaret", "megan"], nate: ["nathan", "nathaniel"], zach: ["zachary"], josh: ["joshua"], al: ["albert", "alan", "allen"],
  charlie: ["charles"], chuck: ["charles"], hank: ["henry"], harry: ["harold", "henry"], jake: ["jacob"], phil: ["phillip", "philip"],
  ray: ["raymond"], ron: ["ronald"], russ: ["russell"], stan: ["stanley"], terry: ["terrence", "theresa"], walt: ["walter"],
  bev: ["beverly"], deb: ["deborah", "debra"], debbie: ["deborah", "debra"], geoff: ["geoffrey"], mandy: ["amanda"], mitch: ["mitchell"],
  pete: ["peter"], randy: ["randall", "randolph"], rod: ["rodney"], sandy: ["sandra"], vince: ["vincent"], wes: ["wesley"],
};
const ROLE_BOX = /^(info|office|lawoffice|lawoffices|admin|contact|hello|law|lawyer|lawyers|attorney|attorneys|intake|mail|legal|team|support|reception|frontdesk|firm|lawfirm|inquiries|inquiry)$/;
// Words a firm's own mailbox is built from, never a person's first name:
// hartwelldefenselaw@, brennanlaw@, okaforlawfirm@.
const FIRM_WORDS = /^(?:the|law|laws|legal|lawfirm|firm|office|offices|attorney|attorneys|atty|esq|pllc|llc|pc|ps|defense|injury|family|group|associates|and|of|at)+$/;
/** Whether an address belongs to the person an email greets: "match" |
 *  "mismatch" | "role" (a shared or firm mailbox) | "unknown". `ctx` gives the
 *  firm's city and domains, so tacomareyes@tacomareyes.example reads as the firm's box. */
export function emailPerson(email, first, last, ctx = {}) {
  const fold = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const f = fold(first).replace(/[^a-z]/g, ""), l = fold(last).replace(/[^a-z]/g, "");
  const parts = fold(String(email ?? "").split("@")[0]).split(/[._+-]+/).map((p) => p.replace(/[^a-z]/g, "")).filter(Boolean);
  const local = parts.join("");
  if (!f || !local) return "unknown";
  const city = fold(ctx.city).replace(/[^a-z]/g, "");
  const labels = (ctx.domains ?? []).map((d) => host(d).split(".")[0].replace(/[^a-z]/g, "")).filter(Boolean);
  const firstLike = (t) => t === f || (t.length >= 3 && f.startsWith(t)) || (f.length >= 3 && t.startsWith(f)) || (NICK[t] ?? []).includes(f);
  if (parts.some(firstLike)) return "match";                                      // rich@ (Richard), michaelj@
  if (l && [f + l, f[0] + l, f + l[0], f[0] + l[0]].includes(local)) return "match"; // rbrennan@, richardb@
  if (l && local.length <= 4 && local[0] === f[0] && local.includes(l[0])) return "match"; // initials: jkd@ (James K. Dalton)
  if (l.length >= 3 && local.includes(l)) {
    const rest = local.replace(l, "");
    if (!rest || firstLike(rest)) return "match";                                  // brennan@
    if (rest.length <= 3 && rest[0] === f[0]) return "match";                       // jkdalton@ (James K.)
    if (FIRM_WORDS.test(rest) || (city && rest === city)) return "match";           // brennanlaw@, tacomareyes@
    return "mismatch";                                                             // bkoh@ for Alan, lee.morgan@ for Dana
  }
  if (ROLE_BOX.test(local) || labels.includes(local)) return "role";               // info@, <firm domain>@
  return "mismatch";                                                               // jeff@ for Michael
}
/** A firm name that ends like a search listing: "<practice> Lawyers/Attorneys". */
/** A job title tacked onto a name: "Dana Whitfield, Attorney", "Lee R. Moss Attorney",
 *  "The Calloway Firm, Attorneys". Brand names ("Sam Ortiz Attorneys") don't match. */
export const TITLE_TAIL = /(,\s*(attorneys?|lawyers?|esq\.?)|\b[A-Z]\.\s+[A-Z][a-z]+\s+attorney)\s*$/i;
export const KEYWORD_TAIL = new RegExp(
  "\\b(accidents?|injury|injuries|bankruptcy|divorce|family law|custody|child support|adoption|criminal|defen[cs]e|dui|dwi|" +
  "felony|misdemeanor|sex crimes?|traffic|immigration|estate planning|wills?|trusts?|probate|guardianship|elder|employment|" +
  "workers'? comp(ensation)?|disability|ssdi|social security|veterans?|business|patent|trademark|tax|real estate|landlord|tenant|" +
  "foreclosure|debt|consumer|insurance|claims?|car|truck(ing)?|motorcycle|bicycle|pedestrian|rideshare|wrongful death|" +
  "malpractice|nursing home|mesothelioma|asbestos|abuse|civil rights|dog bites?|brain injur(y|ies)|slip and fall|" +
  "construction|maritime|aviation|product liability|premises liability)\\b[\\w\\s&,.'-]*\\b(lawyers?|attorneys?)\\s*$",
  "i",
);

export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export function tally(items) {
  const m = new Map();
  for (const k of items) m.set(k, (m.get(k) ?? 0) + 1);
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
}
export const fmtTally = (t) => Object.entries(t).map(([k, v]) => `${k} ${v}`).join(" · ") || "none";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Top-level wrapper: prints a StopError/Error plainly and exits non-zero. */
export async function main(fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`\n${e instanceof StopError ? "" : "ERROR: "}${e.message}`);
    process.exit(e instanceof StopError ? 3 : 1);
  }
}
