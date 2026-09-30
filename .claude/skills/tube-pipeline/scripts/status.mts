// Where does a run stand, and what's next? Read-only (except --mark / --spend).
//
//   npx tsx .claude/skills/tube-pipeline/scripts/status.mts                 every run, newest first
//   npx tsx .claude/skills/tube-pipeline/scripts/status.mts --run <name>    one run in detail + live campaign numbers
//   npx tsx .claude/skills/tube-pipeline/scripts/status.mts --run <name> --mark scan --note "uploaded 186 firms, TuBe est. 6.32"
//   npx tsx .claude/skills/tube-pipeline/scripts/status.mts --run <name> --spend "TuBe scan" --usd 3.30
//
// --mark records a step that happens in the TuBe page (the upload/scan, the
// export download) in run.json, so the ledger shows it. --spend logs money
// actually spent, so the run shows spent vs. the budget in its brief.
import {
  RUNS_ROOT, args, assertRepoCwd, existsSync, getIn, join, listRuns, main, ORG_ID, readCsv, readJson, readRun, runDir, saveRun, stamp,
} from "./lib.mjs";

const when = (s: any) => (s?.at ? new Date(s.at).toLocaleString() : "");

function nextStep(run: any, briefOk: boolean): string {
  const s = run.stages ?? {};
  if (!briefOk) return "Step 0: brief.mjs --run <name>, ask the owner the 10 questions, save brief.json";
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
  if (!u.checked_tube) return "Step 4: run tube-check.js on the TuBe admin page, save its output as tube-scanned.json, re-run build-upload.mts";
  if (u.to_upload > 0 && !s.scan) return `Step 5: upload tube-upload-<run>.csv (${u.to_upload} firms) in TuBe; needs the owner's go (TuBe's estimate ${(u.to_upload * 0.034).toFixed(2)} dollars)`;
  if (u.to_upload > 0 && s.scan) return "Step 5: scan running or done; re-run tube-check.js + build-upload.mts until the upload file is empty, then export";
  if (!s.validate) return `Step 6: export ${(u.tube_batches ?? []).map((b: any) => `"${b.label}"`).join(", ") || "the batch"} in TuBe (owner's go to download), then validate-export.mjs --zip <file>`;
  if (!s.import) return `Step 7: import-campaign.mts dry run → owner's go → --apply (${s.validate.validated} validated, ${s.validate.held} held)`;
  if (!s.verify) return "Step 8: verify-campaign.mts --run <name>";
  return s.verify.with_problems ? `Fix: verify found ${s.verify.with_problems} contacts with problems` : "Done. Check held.csv and TuBe's review list for firms worth a second look.";
}

main(async () => {
  assertRepoCwd();
  const a = args();
  if (typeof a.run !== "string") {
    const runs = listRuns();
    if (!runs.length) { console.log(`No runs yet in ${RUNS_ROOT}. Start one with brief.mjs --run <name>.`); return; }
    for (const r of runs) {
      const u = r.run.stages?.upload;
      const briefOk = existsSync(join(r.dir, "brief.json")) && Boolean(readJson(join(r.dir, "brief.json")).confirmed_at);
      console.log(`${r.name.padEnd(18)} ${u ? `${u.kept} firms in its sheet` : "new"} · next: ${nextStep(r.run, briefOk)}`);
    }
    return;
  }
  const dir = runDir(a.run);
  if (typeof a.mark === "string") {
    stamp(dir, a.mark, { note: typeof a.note === "string" ? a.note : "" });
    console.log(`recorded "${a.mark}" in ${join(dir, "run.json")}`);
    return;
  }
  if (typeof a.spend === "string") {
    const usd = Number(a.usd);
    if (!Number.isFinite(usd) || usd < 0) throw new Error("--spend needs --usd <amount>, e.g. --spend \"TuBe scan\" --usd 3.30");
    const spend = [...(readRun(dir).spend ?? []), { at: new Date().toISOString(), what: a.spend, usd }];
    saveRun(dir, { spend });
    console.log(`logged ${usd.toFixed(2)} for "${a.spend}" · total spent ${spend.reduce((n, x) => n + x.usd, 0).toFixed(2)}`);
    return;
  }
  const run = readRun(dir);
  const briefFile = join(dir, "brief.json");
  const brief = existsSync(briefFile) ? readJson(briefFile) : null;
  const s = run.stages ?? {};
  const cohort = run.cohort ? [run.cohort.tag && `tag ${run.cohort.tag}`, run.cohort.searches?.length && `searches ${run.cohort.searches.map((x: string) => x.slice(0, 8)).join(", ")}`].filter(Boolean).join(" + ") : "not set yet";
  console.log(`Run "${a.run}" (${dir}) · cohort ${cohort}${run.campaign_name ? ` → "${run.campaign_name}"` : ""}`);

  const line = (n: string, label: string, done: any, text: string) => console.log(`  ${done ? "✓" : "·"} ${n} ${label.padEnd(20)} ${done ? `${when(done)}  ${text}` : ""}`);
  if (!brief?.confirmed_at) line("0", "Brief", null, "");
  else {
    const spent = (run.spend ?? []).reduce((n: number, x: any) => n + x.usd, 0);
    const cap = brief.budget?.total_usd;
    line("0", "Brief", { at: null }, `confirmed ${brief.confirmed_at}: ${brief.area?.state ?? "?"}, ${(brief.area?.metros ?? []).length} metros · ${brief.filters?.min_reviews ?? "?"}+ reviews · groups ${(brief.practice?.groups ?? []).join("+") || "?"}`);
    console.log(`      Budget: ${cap == null ? "not set" : `${cap} dollars${brief.budget?.hard_stop ? " (hard stop)" : ""}`} · spent ${spent.toFixed(2)}${cap == null ? "" : ` · left ${(cap - spent).toFixed(2)}`}${(run.spend ?? []).length ? ` (${(run.spend ?? []).map((x: any) => `${x.what} ${x.usd.toFixed(2)}`).join(", ")})` : ""}`);
  }
  const p = s.source_pull, rv = s.source_review, im = s.source_import, es = s.enrich_start, ed = s.enrich_done;
  line("1", "Pull from Scrap.io", p ?? s.source_count, p ? `${p.firms} new firms, ${p.credits_spent} credits (${p.credits_remaining} left)${p.stopped ? ` · STOPPED: ${p.stopped}` : ""}` : s.source_count ? `counted ${s.source_count.total} matches (not pulled yet)` : "");
  line("2", "Review the pull", rv, rv ? `${rv.kept} kept of ${rv.new_firms}, ${rv.dropped} dropped` : "");
  line("3", "Import + enrich", ed ?? es ?? im, ed ? `${ed.firms} firms: ${ed.named} named, ${ed.verified} verified emails, ${ed.tube_ready} TuBe-ready · ${ed.enrichment_usd} dollars` : es ? `enrichment ${es.status} for ${es.contacts} firms (est. ${es.estimate_usd} dollars)` : im ? `imported ${im.inserted}, ${im.pooled} set aside (weak email hosts)` : "");
  const u = s.upload;
  line("4", "Integrity + sheet", u, u ? `${u.kept} of ${u.firms} firms in the sheet (${u.dropped} dropped) · TuBe ${u.checked_tube ? `checked: ${u.already_scanned} already scanned, ${u.to_upload} to upload` : "NOT checked"}` : "");
  line("5", "Upload + scan", s.scan, s.scan?.note ?? "");
  const v = s.validate;
  line("6", "Export + validate", v, v ? `${v.send_rows} to send + ${v.review_rows} in TuBe's review → ${v.validated} clean, ${v.held} held` : "");
  const i = s.import;
  line("7", "Into the campaign", i, i ? `${i.enrolled} enrolled (${i.adopted} adopted), ${i.skipped} skipped` : s.import_plan ? `(dry run only: ${s.import_plan.enroll} planned)` : "");
  const ve = s.verify;
  line("8", "Verify", ve, ve ? `${ve.contacts} contacts, ${ve.emails} emails, ${ve.with_problems} with problems` : "");

  // Live: how far the run's firms have got in the campaign (what it imported, else its sheet).
  const resultFile = join(dir, "import-result.json");
  if (run.campaign_id && (existsSync(resultFile) || existsSync(join(dir, "sheet.csv")))) {
    let ids: string[];
    if (existsSync(resultFile)) ids = readJson(resultFile).contact_ids ?? [];
    else {
      const emails = readCsv(join(dir, "sheet.csv")).map((r: any) => r.email.trim());
      const all = [...new Set([...emails, ...emails.map((e: string) => e.toLowerCase())])];
      ids = (await getIn((l: string) => `contacts?select=id&organization_id=eq.${ORG_ID}&email=in.${l}`, all)).map((c: any) => c.id);
    }
    const enr = await getIn((l: string) => `campaign_enrollments?select=contact_id,status,current_step_index&campaign_id=eq.${run.campaign_id}&contact_id=in.${l}`, ids, 60);
    const sends = await getIn((l: string) => `native_sends?select=contact_id,sent_at&campaign_id=eq.${run.campaign_id}&contact_id=in.${l}`, ids, 60);
    const emailed = new Set(sends.map((x: any) => x.contact_id));
    const replied = enr.filter((e: any) => e.status === "replied").length;
    const last = sends.map((x: any) => x.sent_at).sort().pop();
    console.log(`  Live: ${enr.length} of this run's firms enrolled · ${emailed.size} emailed so far${last ? ` (last ${new Date(last).toLocaleString()})` : ""} · ${replied} replied`);
  }
  console.log(`  Next: ${nextStep(run, Boolean(brief?.confirmed_at))}`);
});
