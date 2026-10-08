// Step 6: validate TuBe's "Export for outreach" before anything reaches LeadStart.
//
//   node .claude/skills/tube-pipeline/scripts/validate-export.mjs --run <name> [--zip <path>[,<path>]] [--no-reports]
//
// --zip extracts TuBe's <sheet>-outreach.zip into <run>/export/<zip name>/.
// Every outreach-send.csv + outreach-review.csv under <run>/export/ is read, and
// each SEND row is checked against:
//   1. what we uploaded (sheet.csv): same email, first name, city and question;
//   2. the export contract: a sendable segment, a real competitor (not a
//      directory, not the firm itself), display-clean names, 0-100 scores, a
//      report link, a rank for "named but not first";
//   3. the firm's own TuBe report page, the ground truth: the question actually
//      asked, the verdict, the AI's first pick, a missed self-mention, and the
//      two scores Email 2 quotes. One GET per row (TuBe's public report link),
//      cached in <run>/reports/; a 403/429 stops the run.
// A row with any issue is HELD, never fixed here. Writes send-validated.csv
// (clean rows), held.csv (rows + reasons) and validation.json; stamps run.json.
import {
  KEYWORD_TAIL, TITLE_TAIL, StopError, args, basename, csvList, emailPerson, existsSync, fmtTally, host, importTube, join, main, mkdirSync, norm,
  parseCsv, readCsv, readFileSync, readJson, readRun, readdirSync, runDir, sleep, stamp, tally, toCsv, unzipToDir, writeFileSync, writeJson,
} from "./lib.mjs";

export const OUTREACH_COLS = ["email", "first_name", "company", "firm", "city", "business_type", "competitor_1", "competitors",
  "question", "ai_rank", "ahead_of_you", "domain_authority", "ai_visibility", "ai_verdict", "segment", "report_link",
  "subject", "hook", "domain", "scanned_at"];
const SENDABLE = new Set(["NOT_NAMED", "NAMED_NOT_FIRST"]);
const DIRECTORY = /chambers|law360|avvo|justia|findlaw|super ?lawyers|martindale|expertise\.com|thumbtack|clutch|yelp|google|yellow ?pages|birdeye|best lawyers|nolo|wikipedia|reddit|linkedin|facebook|\bbbb\b|trustpilot|angi|manta|houzz|department of|county|city of|state bar|bar association|chamber of commerce|university|best law firms|u\.?s\.? news|lawyers of distinction|national trial lawyers|top attorneys|lawinfo|lawyers\.com|legalmatch|hg\.org|threebest|forbes|nerdwallet/i;
const LEGAL_END = /(,\s*|\s+)(pllc|p\.l\.l\.c\.?|pllp|llp|l\.l\.p\.?|llc|l\.l\.c\.?|inc\.?|ltd\.?|p\.\s?s\.?|ps|p\.\s?c\.?|pc|esq\.?|attorneys? at law)\s*$/i;
const GENERIC_ALIAS = /^(law office|law offices|the law office|attorney|attorneys|law firm|legal)$/i;
const FALLBACK_GENERIC = new Set("the and for best near local your company companies service services group home real estate law laws legal lawyer lawyers attorney attorneys firm firms office offices injury injuries accident accidents personal family divorce criminal defense defence planning immigration bankruptcy employment business associates partners pllc pllp trial counsel advocates justice litigation center centre practice north south east west pc ps llc llp inc of at".split(" "));

const decode = (h) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&#x27;|&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;|[“”]/g, '"').replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const normQ = (q) => String(q ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/, "").trim();

main(async () => {
  const a = args();
  const dir = runDir(a.run);
  const tube = await importTube("src/lib/outreachChecks.js");
  const identity = tube ? (s, city) => tube.identity(s, city) : (s) => new Set(norm(s).split(" ").filter((t) => t.length >= 3 && !FALLBACK_GENERIC.has(t)));
  const display = tube ? (s, city) => tube.displayName(s, city) : null;

  // ── the export files ──
  const exportRoot = join(dir, "export");
  for (const zip of csvList(a.zip)) {
    if (!existsSync(zip)) throw new Error(`no such zip: ${zip}`);
    const into = join(exportRoot, basename(zip).replace(/\.zip$/i, ""));
    mkdirSync(into, { recursive: true });
    console.log(`extracted ${unzipToDir(zip, into).join(", ")} → ${into}`);
  }
  const csvs = existsSync(exportRoot) ? readdirSync(exportRoot, { recursive: true }).map(String).filter((f) => /outreach-(send|review)\.csv$/i.test(f)) : [];
  if (!csvs.some((f) => /send/i.test(f))) throw new Error(`no outreach-send.csv under ${exportRoot}: pass --zip <TuBe's -outreach.zip>`);
  const sheetFile = join(dir, "sheet.csv");
  if (!existsSync(sheetFile)) throw new Error(`no sheet.csv in ${dir}: run build-upload.mts first`);
  const sheet = new Map(readCsv(sheetFile).map((r) => [host(r.domain), r]));

  const send = new Map();
  const review = [];
  let duplicates = 0;
  for (const f of csvs) {
    const rows = parseCsv(readFileSync(join(exportRoot, f), "utf8"));
    const missing = OUTREACH_COLS.filter((c) => !rows.columns.includes(c));
    if (missing.length) throw new Error(`${f} lacks columns ${missing.join(", ")}: TuBe's export changed shape; update references/field-contract.md first`);
    if (/review/i.test(f)) { review.push(...rows); continue; }
    for (const r of rows) {
      const d = host(r.domain);
      const prev = send.get(d);
      if (prev) duplicates++;
      if (!prev || String(r.scanned_at) > String(prev.scanned_at)) send.set(d, r);
    }
  }

  // ── completeness: every firm in the sheet must come back scanned ──
  // A stale export (the TuBe page was loaded while scans were finishing) lists
  // finished firms as UNSCANNED, and an incomplete one misses firms. Either would
  // silently drop firms from the campaign (2026-09-30: 19 of 167). A firm counts
  // as scanned if ANY export has it scanned, so an old stale file in the folder
  // can't mask or block a newer complete one.
  const scanned = new Set([...send.keys(), ...review.filter((r) => r.segment !== "UNSCANNED").map((r) => host(r.domain))]);
  const unscanned = [...new Set(review.filter((r) => r.segment === "UNSCANNED").map((r) => host(r.domain)))].filter((d) => !scanned.has(d));
  const notInExport = [...sheet.keys()].filter((d) => !scanned.has(d) && !unscanned.includes(d));
  if (unscanned.length || notInExport.length) {
    // TuBe's last check: build-upload records it in the ledger (and renames the
    // file it read), so the ledger comes first; a fresh unread file second.
    const check = readRun(dir).stages?.upload?.tube_check ?? (existsSync(join(dir, "tube-scanned.json")) ? readJson(join(dir, "tube-scanned.json")) : null);
    const what = [unscanned.length && `${unscanned.length} firms are UNSCANNED in the export`, notInExport.length && `${notInExport.length} firms in the sheet are missing from it`].filter(Boolean).join(" and ");
    const why = !check ? "No TuBe check is recorded: run tube-check.js after the scan finishes, save it, and re-run build-upload.mts."
      : check.open > 0 ? `TuBe's last check shows ${check.open} scans still running: wait, then export again.`
      : check.errors > 0 ? `TuBe's last check shows ${check.errors} failed scans: re-running them needs the owner's go.`
      : "TuBe's last check shows every scan finished, so the export is STALE: reload the TuBe page and export again (tube-browser.md §5).";
    if (!a["allow-incomplete"]) throw new StopError(`REFUSED: ${what}. ${why} Only with the owner's OK: --allow-incomplete.`);
    console.log(`WARNING (--allow-incomplete): ${what}. ${why}`);
  }

  // ── row checks ──
  const results = [];
  let consecutiveFails = 0, fetched = 0;
  mkdirSync(join(dir, "reports"), { recursive: true });
  for (const [domain, r] of send) {
    const issues = [];
    const u = sheet.get(domain);
    const askedCity = u ? `${u.city}, ${u.state}` : r.city;
    // 1. against what we uploaded
    if (!u) issues.push("not in this run's sheet.csv");
    else {
      if (r.email.toLowerCase() !== u.email.toLowerCase()) issues.push(`email changed: ${u.email} → ${r.email}`);
      if (r.first_name !== u.first_name) issues.push(`first_name changed: ${u.first_name} → ${r.first_name}`);
      if (norm(r.city) !== norm(u.city)) issues.push(`city changed: ${u.city} → ${r.city}`);
      if (normQ(r.question) !== normQ(u.seed_query)) issues.push(`asked "${r.question}", the sheet asked "${u.seed_query}"`);
    }
    // 2. the contract
    if (!SENDABLE.has(r.segment)) issues.push(`segment ${r.segment} is not sendable`);
    if (!r.firm) issues.push("no firm name");
    else if (KEYWORD_TAIL.test(r.firm)) issues.push(`firm "${r.firm}" reads like a search listing, not a firm name (the subject and body print it)`);
    else if (TITLE_TAIL.test(r.firm)) issues.push(`firm "${r.firm}" ends with a job title, not the firm's name (the subject and body print it)`);
    if (u && emailPerson(r.email, u.first_name, u.last_name, { city: u.city, domains: [u.domain] }) === "mismatch") {
      issues.push(`wrong person? "Hey ${r.first_name}" would go to ${r.email}, which doesn't look like ${u.first_name} ${u.last_name}'s address`);
    }
    if (!r.competitor_1) issues.push("no competitor_1");
    else if (DIRECTORY.test(r.competitor_1)) issues.push(`competitor_1 looks like a directory/publication: ${r.competitor_1}`);
    const names = [...new Map(
      [u?.company, ...(u?.aliases ?? "").split(";"), [u?.first_name, u?.last_name].filter(Boolean).join(" ")]
        .map((s) => String(s ?? "").trim()).filter(Boolean).map((s) => [norm(s), s]),
    ).values()];
    const comp = identity(r.competitor_1, askedCity);
    for (const n of names) {
      const ids = identity(n, askedCity);
      const shared = [...ids].filter((t) => comp.has(t));
      if (shared.length && shared.length >= Math.min(ids.size, 2)) { issues.push(`competitor_1 "${r.competitor_1}" may be the firm itself (it goes by "${n}")`); break; }
    }
    const nameList = [["firm", r.firm], ["competitor_1", r.competitor_1],
      ...String(r.competitors).split(/ and |; /).map((n) => ["competitors", n]), ...String(r.ahead_of_you).split(/; /).map((n) => ["ahead_of_you", n])];
    for (const [field, n] of nameList) {
      const s = String(n ?? "").trim();
      if (!s) continue;
      if (LEGAL_END.test(s)) issues.push(`${field} still has a legal ending: "${s}"`);
      else if (/[A-Za-z]{6}/.test(s.replace(/[^A-Za-z]/g, "")) && s === s.toUpperCase()) issues.push(`${field} is ALL CAPS: "${s}"`);
      else if (/[|]/.test(s)) issues.push(`${field} carries a listing tagline: "${s}"`);
      else if (display && display(s, askedCity) !== s) issues.push(`${field} is not display-clean: "${s}" (TuBe would print "${display(s, askedCity)}")`);
    }
    for (const k of ["domain_authority", "ai_visibility"]) {
      if (!/^\d{1,3}$/.test(r[k]) || Number(r[k]) > 100) issues.push(`${k} is "${r[k]}", not a 0-100 score`);
    }
    if (!/^https:\/\/[^/\s]+\/api\/prospect-report\?id=[0-9a-f-]{36}$/.test(r.report_link)) issues.push(`odd report link: ${r.report_link}`);
    const rank = r.ai_rank.match(/^(\d+) of (\d+)$/);
    if (r.segment === "NAMED_NOT_FIRST") {
      if (!rank || Number(rank[1]) < 2 || Number(rank[1]) > Number(rank[2])) issues.push(`named-not-first without a usable rank: "${r.ai_rank}"`);
      if (!r.ahead_of_you) issues.push("named-not-first but ahead_of_you is empty");
      else if (norm(r.ahead_of_you.split("; ")[0]) !== norm(r.competitor_1)) issues.push(`ahead_of_you starts "${r.ahead_of_you.split("; ")[0]}", not competitor_1`);
    }
    if (r.segment === "NOT_NAMED" && r.ai_rank) issues.push(`not named, yet ai_rank is "${r.ai_rank}"`);

    // 3. the report page (ground truth)
    const report = {};
    if (!a["no-reports"] && /prospect-report\?id=/.test(r.report_link)) {
      const cache = join(dir, "reports", `${domain}.html`);
      let html = existsSync(cache) ? readFileSync(cache, "utf8") : null;
      if (!html) {
        let res;
        try { res = await fetch(r.report_link, { signal: AbortSignal.timeout(30000) }); } catch (e) { res = { ok: false, status: `network error (${e.message})` }; }
        fetched++;
        if (res.status === 403 || res.status === 429) throw new StopError(`STOPPED: TuBe answered HTTP ${res.status} for ${r.report_link} after ${fetched} report fetches. Wait and re-run (cached pages are kept).`);
        if (!res.ok) {
          issues.push(`report page HTTP ${res.status}`);
          if (++consecutiveFails >= 3) throw new StopError(`STOPPED: 3 report pages in a row failed (last HTTP ${res.status}); TuBe may be down. Re-run later.`);
        } else {
          html = await res.text();
          consecutiveFails = 0;
          if (!/AI Visibility/i.test(html)) { issues.push("report link did not return a TuBe report"); html = null; }
          else writeFileSync(cache, html);
        }
        await sleep(250);
      }
      if (html) {
        const text = decode(html);
        const block = html.split('<div class="qblock">').slice(1).find((b) => normQ(decode(b)).includes(normQ(r.question)));
        if (!block) issues.push(`the report does not show our question "${r.question}"`);
        else {
          const b = decode(block);
          report.verdict = (b.match(/(You never came up|Named #\d+ of \d+|Named first|Came up first|You came up[^.]{0,40})/i) ?? [""])[0];
          const inst = decode((block.match(/<div class="instead">([\s\S]*?)<\/div>/) ?? [])[1] ?? "")
            .replace(/^\s*(AI recommended|Ahead of you)\s*:\s*/i, "").replace(/,?\s*not you\.?\s*$/i, "").trim();
          report.recommended = (inst.includes(";") ? inst.split(/;\s*/) : inst.split(/,\s*/)).map((s) => s.trim()).filter(Boolean);
          report.answer = decode((block.match(/<div class="excerpt">([\s\S]*?)<\/div>/) ?? [])[1] ?? "").replace(/^.*?answered\s*/i, "");
          const named = report.verdict.match(/Named #(\d+) of (\d+)/i);
          if (r.segment === "NOT_NAMED" && !/never came up/i.test(report.verdict)) issues.push(`export says not named; the report says "${report.verdict || "?"}"`);
          if (r.segment === "NAMED_NOT_FIRST") {
            if (!named || Number(named[1]) < 2) issues.push(`export says named but not first; the report says "${report.verdict || "?"}"`);
            else if (rank && (named[1] !== rank[1] || named[2] !== rank[2])) issues.push(`export rank "${r.ai_rank}", the report says "${report.verdict}"`);
          }
          const first = report.recommended[0] ?? "";
          const sameFirm = (x) => norm(x) === norm(r.competitor_1) || norm(x).startsWith(norm(r.competitor_1)) || (display && norm(display(x, askedCity)) === norm(r.competitor_1));
          if (!first) issues.push("the report lists no recommended firms for our question");
          else if (!sameFirm(first)) issues.push(`competitor_1 "${r.competitor_1}", but the AI's first pick on the report is "${first}"`);
          if (r.segment === "NOT_NAMED" && u) {
            const hay = norm(`${report.recommended.join(" | ")} ${report.answer}`);
            for (const alias of names.filter((n) => !GENERIC_ALIAS.test(n) && norm(n).length >= 6)) {
              if (hay.includes(norm(alias))) issues.push(`possible missed self-mention: "${alias}" appears in the AI's answer`);
            }
            // The firm named by its owner's surname ("Mac Allister Law Office") slips past the
            // full-name aliases; a surname hit is held for a look unless a full alias already was.
            const last = norm(u.last_name);
            const selfFlagged = issues.some((i) => i.startsWith("possible missed self-mention"));
            if (!selfFlagged && last.length >= 4 && new RegExp(`\\b${last}\\b`).test(hay)) {
              issues.push(`owner surname "${u.last_name}" appears in the AI's answer (check it isn't them)`);
            }
          }
        }
        const vis = text.match(/(\d{1,3})\s*\/\s*100\s*AI visibility/i)?.[1];
        const auth = text.match(/(\d{1,3})\s*\/\s*100\s*Website authority/i)?.[1];
        report.ai_visibility = vis ?? null;
        report.domain_authority = auth ?? null;
        if (vis == null || auth == null) issues.push("the report page shows no AI visibility / website authority score");
        else {
          if (vis !== r.ai_visibility) issues.push(`ai_visibility ${r.ai_visibility} in the export, ${vis} on the report`);
          if (auth !== r.domain_authority) issues.push(`domain_authority ${r.domain_authority} in the export, ${auth} on the report`);
        }
      }
    }
    results.push({ domain, row: r, issues, report });
  }

  // ── outputs ──
  const clean = results.filter((x) => !x.issues.length);
  const held = results.filter((x) => x.issues.length);
  writeFileSync(join(dir, "send-validated.csv"), toCsv(OUTREACH_COLS, clean.map((x) => x.row)));
  writeFileSync(join(dir, "held.csv"), toCsv([...OUTREACH_COLS, "issues"], held.map((x) => ({ ...x.row, issues: x.issues.join(" | ") }))));
  writeJson(join(dir, "validation.json"), { at: new Date().toISOString(), files: csvs, results: results.map(({ row, ...x }) => ({ ...x, company: row.company, segment: row.segment })) });
  const issueKinds = tally(held.flatMap((x) => x.issues.map((i) => i.replace(/"[^"]*"/g, "…").replace(/\d+/g, "N"))));

  console.log(`Export files: ${csvs.join(", ")}${duplicates ? ` (${duplicates} firms appear in more than one export; kept the newest scan)` : ""}`);
  console.log(`TuBe's split: ${send.size} to send · ${review.length} to review`);
  console.log(`  TuBe's review reasons: ${fmtTally(tally(review.map((r) => `${r.segment}: ${String(r.review_reason ?? "").replace(/"[^"]*"/g, "…").slice(0, 70)}`)))}`);
  console.log(`  send by segment: ${fmtTally(tally([...send.values()].map((r) => r.segment)))}`);
  console.log(`Validated: ${clean.length} clean · ${held.length} held${a["no-reports"] ? " (report pages NOT checked: --no-reports)" : ` (report pages: ${fetched} fetched now, ${send.size - fetched} from cache)`}`);
  for (const [kind, n] of Object.entries(issueKinds)) console.log(`  held · ${kind}: ${n}`);
  for (const x of held.slice(0, 12)) console.log(`    ${x.domain} (${x.row.company}, ${x.row.segment}): ${x.issues.join(" | ")}`);
  if (held.length > 12) console.log(`    … ${held.length - 12} more in held.csv`);
  console.log(`Files: send-validated.csv (${clean.length}), held.csv (${held.length}), validation.json`);
  stamp(dir, "validate", {
    export_files: csvs, send_rows: send.size, review_rows: review.length, validated: clean.length, held: held.length,
    reports_checked: !a["no-reports"], issue_kinds: issueKinds,
    unscanned: unscanned.length, not_in_export: notInExport.length, allowed_incomplete: Boolean(a["allow-incomplete"]),
  });
});
