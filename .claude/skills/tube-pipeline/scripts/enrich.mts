// Step 3b: start LeadStart's enrichment (owner names + verified emails) for the
// run's imported firms. It costs money: DRY RUN unless --apply.
//
//   npx tsx --tsconfig scripts/tsconfig.harness.json .claude/skills/tube-pipeline/scripts/enrich.mts --run <name> [--apply]
//
// Calls the app's own enqueueEnrichment (what Contacts → Enrich runs). Its
// phases and add-ons come from the brief, stamped on each contact at import.
// Weak email hosts stay set aside unless the brief says to enrich them, in which
// case they're released first, the way Contacts → Enrich releases them. The dry
// run states the estimate (WA-10 cost about 1.7 cents per firm) against what's
// left of the brief's budget, and a hard-stop budget refuses an over-budget run.
import {
  ORG_ID, args, assertRepoCwd, existsSync, getIn, importRepo, join, loadEnvIntoProcess, main, readJson, readRun, runDir, stamp, writeJson,
} from "./lib.mjs";

const CENTS_PER_FIRM = 1.7; // WA-10: 9.41 dollars for 565 firms (Apify, Million Verifier, Perplexity)

main(async () => {
  assertRepoCwd();
  loadEnvIntoProcess();
  const { createAdminClient } = await importRepo("src/lib/supabase/admin.ts");
  const { enqueueEnrichment } = await importRepo("src/lib/apify/enqueue-enrichment.ts");
  const { POOL_TAG, withPoolReleased } = await importRepo("src/lib/enrichment/pool.ts");
  const a = args();
  const APPLY = a.apply === true;
  const dir = runDir(a.run);
  const brief = existsSync(join(dir, "brief.json")) ? readJson(join(dir, "brief.json")) : null;
  if (!brief?.confirmed_at) throw new Error(`Run "${a.run}": no confirmed brief.`);
  const impFile = join(dir, "source-import.json");
  if (!existsSync(impFile)) throw new Error(`${impFile} not found: run source-import.mts --apply first`);
  if (existsSync(join(dir, "enrichment.json"))) throw new Error(`Enrichment already started for this run (enrichment.json). Watch it with enrich-watch.mjs.`);
  const imp = readJson(impFile);
  const contacts = await getIn((l: string) => `contacts?select=id,tags,email&organization_id=eq.${ORG_ID}&id=in.${l}`, imp.insertedIds, 100);
  const pooled = contacts.filter((c: any) => (c.tags ?? []).includes(POOL_TAG));
  const releasePooled = brief.enrichment?.weak_hosts === "enrich";
  const toEnrich = releasePooled ? contacts : contacts.filter((c: any) => !(c.tags ?? []).includes(POOL_TAG));
  const estimate = (toEnrich.length * CENTS_PER_FIRM) / 100;
  const spent = (readRun(dir).spend ?? []).reduce((n: number, x: any) => n + x.usd, 0);
  const cap = brief.budget?.total_usd;
  const left = cap == null ? null : cap - spent;

  console.log(`Run "${a.run}" · ${APPLY ? "APPLY" : "dry run"} · imported ${contacts.length} · weak email hosts ${pooled.length} (${releasePooled ? "releasing them: the brief says enrich" : "set aside"})`);
  console.log(`To enrich: ${toEnrich.length} firms · estimate about ${estimate.toFixed(2)} dollars (${CENTS_PER_FIRM} cents a firm on WA-10)`);
  console.log(`Budget: ${cap == null ? "not set in the brief" : `${cap} dollars, ${spent.toFixed(2)} spent, ${left!.toFixed(2)} left`}`);
  if (left != null && estimate > left) {
    const msg = `the estimate (${estimate.toFixed(2)}) is over what's left (${left.toFixed(2)})`;
    if (brief.budget?.hard_stop) throw new Error(`Refusing: ${msg}, and the budget is a hard stop. Ask the owner to raise it or narrow the run.`);
    console.log(`WARNING: ${msg}.`);
  }
  if (!APPLY) {
    console.log("DRY RUN: nothing started. With the owner's go on this cost: --apply. Enrichment takes about 2-3 hours for 300 firms.");
    return;
  }

  const admin = createAdminClient();
  // Attributed to the org owner, as the app's own enrichment cron does.
  const { data: owner } = await admin.from("profiles").select("id").eq("organization_id", ORG_ID).eq("role", "owner").limit(1).maybeSingle();
  if (!owner) throw new Error("no owner profile in the org");
  if (releasePooled && pooled.length) {
    for (const c of pooled) {
      const { error } = await admin.from("contacts").update({ tags: withPoolReleased(c.tags) }).eq("id", c.id);
      if (error) throw new Error(`releasing ${c.id} failed: ${error.message}`);
    }
    console.log(`released ${pooled.length} weak-email-host firms`);
  }
  const result = await enqueueEnrichment(admin, { organizationId: ORG_ID, userId: owner.id, contactIds: toEnrich.map((c: any) => c.id) });
  console.log("enrichment:", JSON.stringify(result));
  if (result.status === "skipped") throw new Error(`Enrichment didn't start: ${result.reason}`);
  writeJson(join(dir, "enrichment.json"), { at: new Date().toISOString(), result, estimate_usd: +estimate.toFixed(2), contacts: toEnrich.length });
  stamp(dir, "enrich_start", { status: result.status, run_id: result.status === "started" ? result.runId : null, contacts: toEnrich.length, estimate_usd: +estimate.toFixed(2) });
  console.log(result.status === "started"
    ? `Started run ${result.runId}. Watch it: node .claude/skills/tube-pipeline/scripts/enrich-watch.mjs --run ${a.run}`
    : `Queued behind another enrichment run (${JSON.stringify(result)}); it starts when that one finishes.`);
});
