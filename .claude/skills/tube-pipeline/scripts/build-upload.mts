// Step 4: pull a cohort out of LeadStart, check its integrity, and build TuBe's
// upload sheet. Read-only on the database.
//
//   npx tsx .claude/skills/tube-pipeline/scripts/build-upload.mts --run <name> \
//       (--searches <id,id> | --tag <tag>) [--campaign <id>] [--include-generic] [--no-brief]
//
// Needs the run's confirmed brief (brief.mjs, references/brief.md): the campaign
// and the "lawyers"-only choice default from it, and the budget left is shown
// against the scan estimate. --no-brief skips that for a read-only re-check only.
//
// Re-running with just --run reuses the cohort saved in run.json. Writes to the
// run folder:
//   sheet.csv          every firm that passed: TuBe's upload format, byte-for-byte
//                      what the in-app "TuBe upload" button builds
//   tube-upload-<run>.csv  sheet.csv minus the firms TuBe has already scanned (TuBe names
//                      its export after this file: tube-upload-<run>-outreach.zip)
//   tube-check.js      snippet for the TuBe admin page: which of these did TuBe scan already?
//   upload-report.json every skip, drop and flag, per firm
// A saved tube-scanned.json (that snippet's output) is decoded into
// tube-scanned-by-domain.json and then set aside, so it is only read once.
import { renameSync, writeFileSync } from "node:fs";
import {
  args, assertRepoCwd, csvList, existsSync, fmtTally, importRepo, join, main, readJson, readRun, rest, runDir, saveRun,
  stamp, tally, TUBE_CAMPAIGN, writeJson,
} from "./lib.mjs";

main(async () => {
  assertRepoCwd();
  const { buildSheet, DROP_LABEL, FLAG_LABEL, resolveCohort } = await import("./cohort.mts");
  const { tubeUploadTable } = await importRepo("src/lib/tube/handoff.ts");
  const { toCsv } = await importRepo("src/lib/csv/to-csv.ts");
  const a = args();
  const dir = runDir(a.run, { create: true });
  const prev = readRun(dir);
  const briefFile = join(dir, "brief.json");
  const brief = existsSync(briefFile) ? readJson(briefFile) : null;
  if (!a["no-brief"] && !brief?.confirmed_at) {
    throw new Error(`Run "${a.run}" has no confirmed brief. Run brief.mjs --run ${a.run}, ask the owner the 10 questions, save brief.json, then re-run.`);
  }

  const cohort = { searches: csvList(a.searches), tag: typeof a.tag === "string" ? a.tag : null };
  if (!cohort.searches.length && !cohort.tag && prev.cohort) Object.assign(cohort, prev.cohort);
  const campaignId = typeof a.campaign === "string" ? a.campaign : brief?.campaign?.id ?? prev.campaign_id ?? TUBE_CAMPAIGN;
  const [campaign] = await rest(`campaigns?select=id,name,status,client_id&id=eq.${campaignId}`);
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);
  saveRun(dir, {
    name: a.run, created_at: prev.created_at ?? new Date().toISOString(), cohort,
    campaign_id: campaign.id, campaign_name: campaign.name,
  });

  // ── the cohort, through the in-app hand-off rules + the pipeline's integrity checks ──
  const { firms, searches } = await resolveCohort(cohort);
  const includeGeneric = a["include-generic"] !== undefined ? Boolean(a["include-generic"]) : Boolean(brief?.practice?.include_generic);
  const { handoff, rows, skipLabel } = await buildSheet(firms, campaign, { includeGeneric });
  const kept = rows.filter((r: any) => !r.drop);
  const dropped = rows.filter((r: any) => r.drop);

  // ── firms TuBe already scanned (tube-check.js output, saved as tube-scanned.json) ──
  const scannedFile = join(dir, "tube-scanned.json");
  const orderFile = join(dir, "tube-check-domains.json");
  const byDomainFile = join(dir, "tube-scanned-by-domain.json");
  const known: Record<string, { id: string; label: string }> = existsSync(byDomainFile) ? readJson(byDomainFile) : {};
  // The latest check's totals (done / still open / failed / done without a PDF).
  let lastCheck = prev.stages?.upload?.tube_check ?? null;
  if (existsSync(scannedFile)) {
    if (!existsSync(orderFile)) throw new Error("tube-scanned.json has no tube-check-domains.json to decode it against");
    const order: string[] = readJson(orderFile);
    const res = readJson(scannedFile);
    if (!res || res.n !== order.length) throw new Error(`tube-scanned.json covers ${res?.n} domains, tube-check-domains.json lists ${order.length}: run the current tube-check.js again`);
    lastCheck = { at: new Date().toISOString(), done: res.done, open: res.open, errors: res.errors, nopdf: res.nopdf ?? null };
    for (const d of order) delete known[d]; // this check is the latest word on every domain it covered
    for (const b of res.batches ?? []) {
      const bits = [...String(b.mask)].flatMap((h) => parseInt(h, 16).toString(2).padStart(4, "0").split("").map(Number));
      order.forEach((d, i) => { if (bits[i]) known[d] = { id: b.id, label: b.label }; });
    }
    writeJson(byDomainFile, known);
    renameSync(scannedFile, join(dir, `tube-scanned.read-${Date.now()}.json`));
  }
  const checked = existsSync(byDomainFile);
  const doneIn = kept.filter((r: any) => known[r.row.domain]).map((r: any) => ({ domain: r.row.domain, ...known[r.row.domain] }));
  const toUpload = kept.filter((r: any) => !known[r.row.domain]);

  // ── files ──
  const sheet = tubeUploadTable(kept.map((r: any) => r.row));
  writeFileSync(join(dir, "sheet.csv"), toCsv(sheet.headers, sheet.rows) + "\r\n", "utf8");
  const up = tubeUploadTable(toUpload.map((r: any) => r.row));
  const uploadName = `tube-upload-${a.run}.csv`;
  writeFileSync(join(dir, uploadName), toCsv(up.headers, up.rows) + "\r\n", "utf8");
  const order = kept.map((r: any) => r.row.domain);
  writeJson(orderFile, order);
  writeFileSync(join(dir, "tube-check.js"), tubeCheckSnippet(order, a.run));
  writeJson(join(dir, "upload-report.json"), {
    searches,
    handoff_skipped: handoff.skipped.map((s: any) => ({ ...s, label: skipLabel[s.reason] })),
    dropped: dropped.map((r: any) => ({ domain: r.row.domain, company: r.row.company, email: r.row.email, reason: r.drop, label: DROP_LABEL[r.drop], blank: r.blank })),
    flags: kept.filter((r: any) => r.flags.length).map((r: any) => ({ domain: r.row.domain, company: r.row.company, first_name: r.row.first_name, email: r.row.email, flags: r.flags })),
    already_scanned: doneIn,
  });

  // ── report ──
  console.log(`Run "${a.run}" → ${dir}`);
  console.log(`Cohort: ${searches.map((s: any) => `${s.id.slice(0, 8)} (${s.places} places)`).join(", ")} → ${firms.length} firms`);
  console.log(`TuBe hand-off (the in-app rules): ${handoff.rows.length} rows; left out ${handoff.skipped.length}: ${fmtTally(tally(handoff.skipped.map((s: any) => skipLabel[s.reason])))}`);
  if (handoff.genericCount && !includeGeneric) console.log(`  ${handoff.genericCount} of those only say "lawyers": --include-generic would scan them with the broad question`);
  console.log(`Integrity vs "${campaign.name}" (${campaign.status}): kept ${kept.length}; dropped ${dropped.length}${dropped.length ? `: ${fmtTally(tally(dropped.map((r: any) => DROP_LABEL[r.drop])))}` : ""}`);
  for (const [flag, n] of Object.entries(tally(kept.flatMap((r: any) => r.flags)))) {
    const eg = kept.filter((r: any) => r.flags.includes(flag)).slice(0, 4)
      .map((r: any) => (flag === "odd_first_name" ? `"${r.row.first_name}" at ${r.row.company}` : r.row.company));
    console.log(`  flag · ${FLAG_LABEL[flag]}: ${n} (e.g. ${eg.join("; ")})`);
  }
  if (checked) {
    console.log(`Already scanned in TuBe: ${doneIn.length} of ${kept.length}${doneIn.length ? ` (batch ${fmtTally(tally(doneIn.map((d: any) => `"${d.label}"`)))})` : ""}`);
    if (lastCheck?.open) console.log(`  still scanning: ${lastCheck.open} (re-run tube-check.js until this is 0)`);
    if (lastCheck?.errors) console.log(`  failed scans: ${lastCheck.errors} (TuBe's "Re-run unfinished" retries them; ask the owner first)`);
    if (lastCheck?.nopdf) console.log(`  ${lastCheck.nopdf} scanned firms have no PDF: their report link works, but TuBe's download button offers only a re-scan. Answer a "send it" from them with the link.`);
  } else console.log("Already scanned in TuBe: NOT CHECKED. Run tube-check.js on the TuBe admin page (references/tube-browser.md §2), save its output as tube-scanned.json, then re-run this.");
  console.log(`${uploadName}: ${toUpload.length} firms to scan. TuBe's own estimate: $${(toUpload.length * 0.034).toFixed(2)} at 3.4¢ each (the 9/25 WA batch cost 1.75¢ each: firms asking the same question share one answer)`);
  if (brief?.budget?.total_usd != null) {
    const spent = (prev.spend ?? []).reduce((n: number, x: any) => n + x.usd, 0);
    const left = brief.budget.total_usd - spent;
    const est = toUpload.length * 0.034;
    console.log(`Budget: ${brief.budget.total_usd} dollars, ${spent.toFixed(2)} spent, ${left.toFixed(2)} left${est > left ? ` · WARNING: the scan estimate (${est.toFixed(2)}) is over what's left${brief.budget.hard_stop ? ", and the budget is a hard stop" : ""}` : ""}`);
  }
  console.log(`Cities: ${fmtTally(tally(kept.map((r: any) => `${r.row.city}, ${r.row.state}`)))}`);
  console.log(`Practice areas: ${fmtTally(tally(kept.map((r: any) => r.row.business_type)))}`);
  if (kept.length) console.log(`Sample questions: ${kept.slice(0, 3).map((r: any) => r.row.seed_query).join(" | ")}`);
  stamp(dir, "upload", {
    firms: firms.length, handoff_rows: handoff.rows.length, kept: kept.length, dropped: dropped.length,
    checked_tube: checked, already_scanned: doneIn.length, to_upload: toUpload.length, tube_check: lastCheck,
    tube_batches: [...new Map(doneIn.map((d: any) => [d.id, { id: d.id, label: d.label }])).values()],
  });
});

/** JS for the TuBe admin page (javascript_tool): which of these domains TuBe has a
 *  DONE scan for, per batch, as a hex bitmask over `order`. The tool returns only
 *  ~1,000 characters, so a domain list can't come back; a bitmask can. Uses the
 *  page's own signed-in Supabase client, read-only. Also the progress check while
 *  a scan runs (open = queued/running scans among these domains). */
function tubeCheckSnippet(order: string[], run: string): string {
  return `// tube-pipeline run "${run}": which of these ${order.length} domains has TuBe scanned already? (read-only)
const D = ${JSON.stringify(order)};
let result;
try {
  let sb = null;
  for (const u of performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\\/assets\\/supabase-[^/]+\\.js/.test(n))) {
    try { const m = await import(u); sb = Object.values(m).find((v) => v && typeof v.from === 'function' && typeof v.rpc === 'function' && v.auth); } catch {}
    if (sb) break;
  }
  if (!sb) throw new Error('no Supabase client on this page: open https://tube-seo.vercel.app/admin first');
  const rows = [];
  for (let i = 0; i < D.length; i += 100) {
    const { data, error } = await sb.from('prospect_scans').select('domain,status,batch_id,created_at,report_pdf_url').in('domain', D.slice(i, i + 100));
    if (error) throw new Error(error.message);
    rows.push(...data);
  }
  const best = new Map();
  for (const r of rows) {
    const p = best.get(r.domain);
    const rd = r.status === 'done', pd = Boolean(p && p.status === 'done');
    if (!p || (rd && !pd) || (rd === pd && r.created_at > p.created_at)) best.set(r.domain, r);
  }
  const batches = new Map();
  D.forEach((d, i) => {
    const r = best.get(d);
    if (!r || r.status !== 'done' || !r.batch_id) return;
    if (!batches.has(r.batch_id)) batches.set(r.batch_id, { id: r.batch_id, bits: new Array(D.length).fill(0) });
    batches.get(r.batch_id).bits[i] = 1;
  });
  for (const b of batches.values()) {
    const { data } = await sb.from('prospect_scans').select('created_at').eq('batch_id', b.id).order('created_at', { ascending: true }).limit(1);
    b.label = data && data[0] ? new Date(data[0].created_at).toLocaleString() : '?';
  }
  const hex = (bits) => { let s = ''; for (let i = 0; i < bits.length; i += 4) s += ((bits[i] << 3) | ((bits[i + 1] || 0) << 2) | ((bits[i + 2] || 0) << 1) | (bits[i + 3] || 0)).toString(16); return s; };
  const open = [...best.values()].filter((r) => r.status === 'queued' || r.status === 'running').length;
  const errors = [...best.values()].filter((r) => r.status === 'error').length;
  const nopdf = [...best.values()].filter((r) => r.status === 'done' && !r.report_pdf_url).length;
  result = JSON.stringify({ n: D.length, done: [...batches.values()].reduce((a, b) => a + b.bits.reduce((x, y) => x + y, 0), 0), open, errors, nopdf, batches: [...batches.values()].map((b) => ({ id: b.id, label: b.label, mask: hex(b.bits) })) });
} catch (e) {
  result = 'ERROR: ' + e.message;
}
result
`;
}
