// Step 3c: watch the run's enrichment. Read-only.
//
//   node .claude/skills/tube-pipeline/scripts/enrich-watch.mjs --run <name>            one status line
//   node .claude/skills/tube-pipeline/scripts/enrich-watch.mjs --run <name> --follow   a line per phase change and a
//        heartbeat about every 10 minutes, until the run ends (start it in the background)
//
// Finds the enrichment run from enrichment.json, or, when it was queued behind
// another run, from the run items of the contacts this run imported.
// --follow exits 3 on an error or 3+ failures in a row, and 4 after 45 minutes
// without progress, so a background watcher reports trouble instead of waiting forever.
import { args, findEnrichmentRun, main, rest, runDir, sleep } from "./lib.mjs";

const COLS = "id,status,phase,total_count,phase_total_count,processed_count,progress_message,error_message,consecutive_failures,cost_usd,found_names_count,found_emails_count,found_verified_count,started_at,completed_at";

const line = (r) =>
  `${new Date().toISOString().slice(11, 16)}Z ${r.status}/${r.phase} · ${r.processed_count ?? 0}/${r.phase_total_count ?? r.total_count} in this phase` +
  ` · names ${r.found_names_count ?? 0} · emails ${r.found_emails_count ?? 0} · verified ${r.found_verified_count ?? 0}` +
  ` · ${Number(r.cost_usd ?? 0).toFixed(2)} dollars so far${r.progress_message ? ` · ${r.progress_message}` : ""}`;

main(async () => {
  const a = args();
  const dir = runDir(a.run);
  const id = typeof a.id === "string" ? a.id : await findEnrichmentRun(dir);
  if (!id) {
    console.log("No enrichment run found yet (not started, or still queued behind another run).");
    return;
  }
  const read = async () => (await rest(`enrichment_runs?select=${COLS}&id=eq.${id}`))[0];
  let r = await read();
  if (!r) throw new Error(`enrichment run ${id} not found`);
  console.log(`run ${id}\n${line(r)}`);
  if (!a.follow) return;

  let last = `${r.status}/${r.phase}`, lastErr = `${r.error_message ?? ""}|${r.consecutive_failures ?? 0}`, beat = 0;
  let lastProgress = "", lastChange = Date.now();
  while (!["complete", "failed", "cancelled", "error"].includes(r.status)) {
    await sleep(120_000);
    try {
      r = await read();
    } catch (e) {
      console.log(`poll error: ${String(e).slice(0, 160)}`);
      continue;
    }
    const key = `${r.status}/${r.phase}`;
    const err = `${r.error_message ?? ""}|${r.consecutive_failures ?? 0}`;
    if (key !== last) { console.log(`PHASE ${line(r)}`); last = key; beat = 0; }
    else if (err !== lastErr) console.log(`ALERT ${line(r)} · error: ${r.error_message ?? "none"} · failures in a row ${r.consecutive_failures}`);
    else if (++beat % 5 === 0) console.log(`beat  ${line(r)}`);
    lastErr = err;
    const progress = `${key}|${r.processed_count}|${r.progress_message}|${r.cost_usd}`;
    if (progress !== lastProgress) { lastProgress = progress; lastChange = Date.now(); }
    if (r.error_message || (r.consecutive_failures ?? 0) >= 3) { console.log(`EXIT-ALERT ${line(r)}`); process.exit(3); }
    if (Date.now() - lastChange > 45 * 60_000) { console.log(`EXIT-STALL no progress for 45 minutes · ${line(r)}`); process.exit(4); }
  }
  console.log(`DONE ${line(r)}`);
});
