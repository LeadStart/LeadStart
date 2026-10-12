// Step 3d: after enrichment, the run's yield and full cost. Read-only on the
// database; logs the actual enrichment spend in run.json against the budget.
//
//   npx tsx .claude/skills/tube-pipeline/scripts/enrich-report.mts --run <name> [--search <id> --enrichment <id>]
//
// Cost basis (WA-10's): enrichment_runs.cost_usd (Apify + Million Verifier + LLM
// tokens). Perplexity's per-request fee (0.5 cents a call) is in cost_usd from
// 2026-10-12, when the run has a Perplexity share in cost_breakdown. A run
// recorded before that left it out, so the fee is added back for each
// Perplexity call its notes show: owner-name lookups (Perplexity until
// 2026-10-11) and website lookups (src/lib/enrichment/perplexity-calls.ts).
// Scrap.io credits are prepaid, so they're reported as credits, not dollars.
// The TuBe-ready count is the in-app "TuBe upload" rule (buildTubeHandoff), the
// same one step 4 applies.
import {
  ORG_ID, args, assertRepoCwd, existsSync, findEnrichmentRun, fmtTally, getAll, importRepo, join, main, readJson, readRun, rest, runDir,
  saveRun, stamp,
} from "./lib.mjs";

main(async () => {
  assertRepoCwd();
  const { buildTubeHandoff, TUBE_SKIP_LABEL } = await importRepo("src/lib/tube/handoff.ts");
  const { classifyEmailTier } = await importRepo("src/lib/enrichment/email-tier.ts");
  const { PERPLEXITY_FEE_USD, countLookupCalls, countNamingCalls, lookupCallsInNote, perplexityFeeRecorded } =
    await importRepo("src/lib/enrichment/perplexity-calls.ts");
  const { discoveryLocation } = await importRepo("src/lib/enrichment/domain-discovery.ts");
  const { costShares } = await importRepo("src/lib/enrichment/run-cost.ts");
  const a = args();
  const dir = runDir(a.run);
  const imp = existsSync(join(dir, "source-import.json")) ? readJson(join(dir, "source-import.json")) : null;
  const searchId = typeof a.search === "string" ? a.search : imp?.search_id;
  const runId = typeof a.enrichment === "string" ? a.enrichment : await findEnrichmentRun(dir);
  if (!searchId || !runId) throw new Error("Need the run's search and enrichment run (source-import.json + enrichment), or --search and --enrichment.");
  const pull = existsSync(join(dir, "scrapio-pull.json")) ? readJson(join(dir, "scrapio-pull.json")) : null;

  const [s] = await rest(`maps_searches?select=id,query,results,delivered_counts&id=eq.${searchId}`);
  // select=* reads cost_breakdown where migration 00138 is applied and still works where it isn't.
  const [run] = await rest(`enrichment_runs?select=*&id=eq.${runId}`);
  if (!s || !run) throw new Error("search or enrichment run not found");
  const items = await getAll(`enrichment_run_items?select=id,created_at,contact_id,company_id,company_slug,company_name,domain_status,domain_notes,naming_notes&run_id=eq.${runId}`);
  // Perplexity calls whose fee cost_usd left out: none once the run records it.
  const feeRecorded = perplexityFeeRecorded(run);
  let pplx = 0;
  if (!feeRecorded) {
    // A website lookup's firm is grouped by the contact's location, as the cron did.
    const lookupContacts = [...new Set(items.filter((it: any) => lookupCallsInNote(it.domain_notes) > 0).map((it: any) => it.contact_id))];
    const byId = new Map();
    for (let i = 0; i < lookupContacts.length; i += 100) {
      for (const c of await getAll(`contacts?select=id,location,enrichment_data&id=in.(${lookupContacts.slice(i, i + 100).join(",")})`)) byId.set(c.id, c);
    }
    pplx = countNamingCalls(items) + countLookupCalls(items, (it: any) => discoveryLocation(byId.get(it.contact_id))).calls;
  }
  const contacts = await getAll(`contacts?select=google_place_id,first_name,last_name,email,company_email,company_name,tags,email_verification_status,email_verification_subresult,email_kind:enrichment_data->enrichment->email->>kind,email_provider_status:enrichment_data->enrichment->email->>provider_status,email_provider:enrichment_data->enrichment->email->>provider&organization_id=eq.${ORG_ID}&enrichment_data->>maps_search_id=eq.${searchId}`);

  const firms = contacts.length;
  const pooled = contacts.filter((c: any) => (c.tags ?? []).includes("pooled-weak-host")).length;
  const named = contacts.filter((c: any) => (c.first_name ?? "").trim()).length;
  const verified = contacts.filter((c: any) => classifyEmailTier(c) === "person" && c.email_verification_status === "ok").length;
  const byPlace = new Map(contacts.map((c: any) => [c.google_place_id, c]));
  const h = buildTubeHandoff((s.results ?? []).map((p: any) => ({
    placeName: p.name, categories: p.categories ?? [], city: p.city, state: p.state,
    domain: p.company_domain || p.website, contact: byPlace.get(p.google_place_id) ?? null,
  })), { keepDomains: readRun(dir).stages?.source_review?.kept_by_hand ?? [] }); // the owner's keeps at review (step 2)
  const recordedUsd = Number(run.cost_usd ?? 0);
  const enrichUsd = recordedUsd + pplx * PERPLEXITY_FEE_USD;
  const split = costShares(run).map((x: any) => `${x.label} ${x.usd.toFixed(2)}`).join(", ");
  const pct = (n: number, of = firms) => `${n} of ${of} (${of ? Math.round((100 * n) / of) : 0}%)`;
  const mins = run.completed_at ? Math.round((+new Date(run.completed_at) - +new Date(run.started_at)) / 60000) : null;

  console.log(`Enrichment ${run.status}${mins != null ? ` in ${mins} minutes` : ` (${run.phase}: ${run.progress_message ?? ""})`}`);
  console.log(`Firms imported ${firms} · set aside as weak email hosts ${pooled} · owner named ${pct(named)} · verified personal email ${pct(verified)}`);
  console.log(`TuBe-ready (the in-app rule): ${h.rows.length} · left out: ${fmtTally(Object.fromEntries(
    [...h.skipped.reduce((m: Map<string, number>, k: any) => m.set(TUBE_SKIP_LABEL[k.reason], (m.get(TUBE_SKIP_LABEL[k.reason]) ?? 0) + 1), new Map())].sort((x, y) => y[1] - x[1])))}`);
  const basis = feeRecorded
    ? `recorded, Perplexity's fee included${split ? `: ${split}` : ""}`
    : `${recordedUsd.toFixed(2)} recorded + ${pplx} Perplexity calls ${(pplx * PERPLEXITY_FEE_USD).toFixed(2)}`;
  console.log(`Cost: enrichment ${enrichUsd.toFixed(2)} dollars (${basis})` +
    ` · ${firms ? ((100 * enrichUsd) / firms).toFixed(2) : "?"} cents a firm · ${h.rows.length ? ((100 * enrichUsd) / h.rows.length).toFixed(1) : "?"} cents a TuBe-ready firm` +
    `${pull ? ` · Scrap.io ${pull.spent} credits` : ""}`);

  if (run.status === "complete") {
    const r = readRun(dir);
    const spend = [...(r.spend ?? []).filter((x: any) => x.what !== "LeadStart enrichment"), { at: new Date().toISOString(), what: "LeadStart enrichment", usd: +enrichUsd.toFixed(2) }];
    saveRun(dir, { spend });
    stamp(dir, "enrich_done", { firms, pooled, named, verified, tube_ready: h.rows.length, enrichment_usd: +enrichUsd.toFixed(2), minutes: mins });
    console.log(`Logged ${enrichUsd.toFixed(2)} dollars of enrichment in the run's spend. Next: step 4, build-upload.mts --run ${a.run}.`);
  } else console.log("Enrichment hasn't finished: nothing logged. Run this again when enrich-watch says DONE.");
});
