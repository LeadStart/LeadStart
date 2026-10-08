// Step 1: size and pull the brief's firms from Scrap.io.
//
//   node .claude/skills/tube-pipeline/scripts/source-pull.mjs --run <name>               the plan (nothing sent to Scrap.io)
//   node .claude/skills/tube-pipeline/scripts/source-pull.mjs --run <name> --count --go  free counts, brief's metros only
//   node .claude/skills/tube-pipeline/scripts/source-pull.mjs --run <name> --pull --go   the paid pull, capped [--cap <credits>]
//
// --go is the owner's approval for exactly what the plan printed; pass it only
// after the owner says go in chat. Counts cost no credits but use Scrap.io's
// fair-use search quota: one search per metro per practice group, nothing more.
// Every search claims a slot in the shared search log first (scrapio.mjs), and
// both modes check that their whole job fits the ceilings before sending any.
// The pull first syncs our block list (firms added to LeadStart since the last
// sync), so firms we already have come back as free stubs. After every page it
// adds that page's firms and their websites to the block list, so no firm is
// paid for twice. Every raw page is appended to <run>/scrapio-raw.jsonl as it
// arrives. Nothing is written to LeadStart here.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ORG_ID, RUNS_ROOT, StopError, args, getAll, join, main, readJson, runDir, sleep, stamp } from "./lib.mjs";
import { BLOCKLIST, RUN_LIMIT, assertSearchBudget, briefTypes, credits, fmtBudget, isFirmDomain, pushBlock, sc, searchBudget, searchPairs, webHost } from "./scrapio.mjs";

const SYNC_FILE = join(RUNS_ROOT, ".scrapio-blocklist-sync.json");
// The WA-10 pull (2026-09-25) pushed every firm it touched as it went.
const FIRST_SYNC_FROM = "2026-09-26T00:00:00Z";

// Searches the pull will send, from the counts: every match fills a page slot
// (firms we already have come back as free stubs but still take slots), an
// empty group still costs its first page, and a capped metro stops once its
// cap of new firms is in. null when the counts don't cover every metro.
function pullPages(countsFile, metros, groups, caps) {
  if (!existsSync(countsFile)) return null;
  const rows = readJson(countsFile).rows ?? [];
  const gs = Object.keys(groups);
  let pages = 0;
  for (const city of metros) {
    const r = rows.find((x) => x.city === city);
    if (!r || gs.some((g) => !Number.isFinite(r[g]))) return null;
    const all = gs.reduce((n, g) => n + Math.max(1, Math.ceil(r[g] / 50)), 0);
    pages += caps[city] ? Math.min(all, Math.ceil(caps[city] / 50) + gs.length) : all;
  }
  return pages;
}

main(async () => {
  const a = args();
  const dir = runDir(a.run);
  const briefFile = join(dir, "brief.json");
  if (!existsSync(briefFile)) throw new Error(`No brief for run "${a.run}": run brief.mjs and ask the owner first.`);
  const brief = readJson(briefFile);
  if (!brief.confirmed_at) throw new Error(`Run "${a.run}": the brief isn't confirmed by the owner yet.`);
  if (brief.source?.kind && brief.source.kind !== "scrapio") throw new Error(`The brief says the source is ${brief.source.kind}, not Scrap.io.`);
  const state = String(brief.area?.state ?? "").toUpperCase();
  const metros = brief.area?.metros ?? [];
  if (!/^[A-Z]{2}$/.test(state) || !metros.length) throw new Error("The brief needs area.state (2 letters) and area.metros.");
  const groups = briefTypes(brief);
  const minReviews = Number(brief.filters?.min_reviews ?? 10);
  const caps = brief.area?.caps ?? {};
  const creditCap = Number(a.cap ?? brief.source?.credits_cap ?? NaN);
  const filters = { state, minReviews, website: brief.filters?.website !== false, openOnly: brief.filters?.open_only !== false };
  const searches = metros.length * Object.keys(groups).length;
  const countsFile = join(dir, "scrapio-counts.json");
  const pages = pullPages(countsFile, metros, groups, caps);

  if (!a.count && !a.pull) {
    const b = await searchBudget();
    const fits = (n) => (n <= b.left ? "fits" : `does NOT fit: only ${b.left} left, so narrow the metros or wait`);
    console.log(`Run "${a.run}": Scrap.io plan from the brief (nothing sent to Scrap.io)`);
    console.log(`  Area: ${state} · ${metros.length} metros: ${metros.map((m) => (caps[m] ? `${m} (cap ${caps[m]})` : m)).join(", ")}`);
    // Already worked for this client? (docs/clients/<slug>.md) Firms we have come
    // back free, but re-searching a city still spends searches.
    if (brief.campaign?.id) {
      const { configForCampaign } = await import("./client-ledger.mjs");
      const led = await configForCampaign(brief.campaign.id).catch(() => null);
      const done = (led?.config?.runs ?? []).filter((r) => r.state === state).flatMap((r) => (r.metros ?? []).map((m) => ({ m, r })));
      const again = metros.map((m) => done.find((d) => d.m.toLowerCase() === m.toLowerCase())).filter(Boolean);
      if (again.length) console.log(`  ALREADY WORKED for this client: ${again.map(({ m, r }) => `${m} (${r.run}, ${r.date})`).join(", ")}. Confirm with the owner before searching them again.`);
    }
    console.log(`  Practice groups: ${Object.entries(groups).map(([g, t]) => `${g} (${t.length} types)`).join(", ")} · ${minReviews}+ reviews${filters.website ? " · website" : ""}${filters.openOnly ? " · open" : ""}`);
    console.log(`  Search log: ${fmtBudget(b)} → ${b.left} more fit now (at most ${RUN_LIMIT} per run).`);
    console.log(`  Counts (free, fair-use quota): ${searches} searches (${metros.length} metros × ${Object.keys(groups).length} groups), plus 2 credit reads: ${fits(searches)}.`);
    console.log(`  Pull (paid): ${Number.isFinite(creditCap) ? `stops at ${creditCap} credits` : "NO CREDIT CAP SET: add source.credits_cap to the brief or pass --cap"}; about 1 credit per new firm, free for firms we already have.`);
    console.log(`  Pull searches: ${pages === null ? "known after the counts" : `about ${pages} pages: ${fits(pages)}`}.`);
    console.log(`  Ask the owner, e.g. "May I run ${searches} free count searches?" then --count --go; "May I pull up to ${Number.isFinite(creditCap) ? creditCap : "N"} credits (about ${pages ?? "N"} searches)?" then --pull --go.`);
    return;
  }
  if (a.go !== true) throw new Error("Add --go only after the owner approved exactly this in chat (the plan prints what to ask).");

  // ── counts: one free search per metro per group ──
  if (a.count) {
    await assertSearchBudget(searches, `The counts (${metros.length} metros × ${Object.keys(groups).length} groups)`);
    const c0 = await credits();
    const rows = [];
    for (const city of metros) {
      const line = { city };
      for (const [g, types] of Object.entries(groups)) {
        const r = await sc("/gmap/search", [...searchPairs({ ...filters, city, types }), ["per_page", "1"], ["skip_data", "1"]]);
        if (r.status !== 200 && r.status !== 202) throw new Error(`count ${city}/${g}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        const n = Number(r.body?.meta?.count);
        if (!Number.isFinite(n)) throw new Error(`count ${city}/${g}: no count in the answer ${JSON.stringify(r.body?.meta ?? r.body).slice(0, 200)}`);
        line[g] = n;
        if (r.body?.meta?.status && r.body.meta.status !== "completed") line[`${g}_status`] = r.body.meta.status;
        await sleep(600);
      }
      rows.push(line);
      console.log(`  ${city.padEnd(16)} ${Object.keys(groups).map((g) => `${g} ${line[g]}${line[`${g}_status`] ? ` (${line[`${g}_status`]})` : ""}`).join("  ")}`);
    }
    const c1 = await credits();
    if (c1.consumed !== c0.consumed) throw new Error(`Credits moved during free counts (${c0.consumed} → ${c1.consumed}). Stop and tell the owner.`);
    const total = rows.reduce((n, r) => n + Object.keys(groups).reduce((m, g) => m + r[g], 0), 0);
    writeFileSync(join(dir, "scrapio-counts.json"), JSON.stringify({ at: new Date().toISOString(), filters, rows, total, credits: c1 }, null, 1));
    console.log(`Total matches ${total}. This includes firms we already have (free stubs) and overlap between groups, so new firms will be fewer. Credits unchanged: ${c1.consumed} used, ${c1.remaining} left.`);
    stamp(dir, "source_count", { searches, total, credits_remaining: c1.remaining });
    return;
  }

  // ── the pull ──
  if (!Number.isFinite(creditCap) || creditCap <= 0) throw new Error("No credit cap: add source.credits_cap to the brief (or --cap) with the owner's number.");
  if (pages === null) throw new Error("Run --count first (for every metro in the brief): the pull needs its page count to check the search limits.");
  await assertSearchBudget(pages, `The pull (about ${pages} pages)`);
  const c0 = await credits();
  if (c0.remaining < creditCap) console.log(`Note: ${c0.remaining} credits left, below the cap of ${creditCap}; the pull stops when they run out.`);

  // Block list: firms added to LeadStart since the last sync.
  const since = existsSync(SYNC_FILE) ? JSON.parse(readFileSync(SYNC_FILE, "utf8")).last_sync : FIRST_SYNC_FROM;
  const syncStart = new Date().toISOString();
  const recent = await getAll(`contacts?select=google_place_id,company_domain&organization_id=eq.${ORG_ID}&created_at=gte.${since}`);
  const syncIds = [...new Set(recent.map((r) => r.google_place_id).filter(Boolean))];
  const syncDomains = [...new Set(recent.map((r) => String(r.company_domain ?? "").toLowerCase().replace(/^www\./, "")).filter(isFirmDomain))];
  console.log(`Block list "${BLOCKLIST}": syncing ${syncIds.length} place ids + ${syncDomains.length} domains added since ${since}`);
  await pushBlock("place_id", syncIds);
  await pushBlock("domain", syncDomains);
  writeFileSync(SYNC_FILE, JSON.stringify({ last_sync: syncStart }, null, 1));
  const c1 = await credits();
  if (c1.consumed !== c0.consumed) throw new Error(`The block-list sync moved credits (${c0.consumed} → ${c1.consumed}). Stop and tell the owner.`);

  const raw = join(dir, "scrapio-raw.jsonl");
  let prev = c1.consumed;
  const tally = [];
  const byMetro = {};
  let stopped = null;
  outer: for (const city of metros) {
    for (const [g, types] of Object.entries(groups)) {
      let cursor = null, page = 0, rowsN = 0, stubsN = 0, charged = 0;
      for (;;) {
        if (prev - c0.consumed >= creditCap) { stopped = `credit cap ${creditCap} reached before ${city}/${g} page ${page + 1}`; break outer; }
        if (caps[city] && (byMetro[city] ?? 0) >= caps[city]) break;
        let r;
        try {
          r = await sc("/gmap/search", [...searchPairs({ ...filters, city, types }), ["per_page", "50"], ...(cursor ? [["cursor", cursor]] : [])]);
        } catch (e) {
          // A search limit or a 403/429: stop here, but still write what came in.
          if (!(e instanceof StopError)) throw e;
          stopped = `${city}/${g} page ${page + 1}: ${e.message}`;
          break outer;
        }
        if (r.status !== 200 && r.status !== 202) { stopped = `${city}/${g} page ${page + 1}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`; break outer; }
        const rows = r.body?.data ?? [];
        page++;
        appendFileSync(raw, JSON.stringify({ city, group: g, page, http: r.status, meta: r.body?.meta, data: rows }) + "\n");
        const real = rows.filter((p) => p.blacklisted !== true);
        const now = (await credits()).consumed;
        const cost = now - prev;
        prev = now;
        rowsN += rows.length;
        stubsN += rows.length - real.length;
        charged += cost;
        byMetro[city] = (byMetro[city] ?? 0) + real.length;
        if (cost > real.length + 2) { stopped = `${city}/${g} page ${page}: charged ${cost} credits for ${real.length} new firms`; break outer; }
        const ids = real.map((p) => p.place_id).filter(Boolean);
        const doms = [...new Set(real.map((p) => webHost(p.website ?? "")).filter(isFirmDomain))];
        if (ids.length) await pushBlock("place_id", ids);
        if (doms.length) await pushBlock("domain", doms);
        cursor = r.body?.meta?.next_cursor ?? null;
        if (!cursor || rows.length === 0) break;
        await sleep(600);
      }
      tally.push({ city, group: g, pages: page, rows: rowsN, stubs: stubsN, firms: rowsN - stubsN, credits: charged });
      console.log(`  ${city.padEnd(16)} ${g}: ${page} pages · ${rowsN - stubsN} new firms + ${stubsN} we already have · ${charged} credits · pull total ${prev - c0.consumed}`);
    }
  }
  const cEnd = await credits();
  const spent = cEnd.consumed - c0.consumed;
  const firms = tally.reduce((n, t) => n + t.firms, 0);
  writeFileSync(join(dir, "scrapio-pull.json"), JSON.stringify({ at: new Date().toISOString(), filters, metros, credits_before: c0, credits_after: cEnd, spent, stopped, tally }, null, 1));
  console.log(`${stopped ? `STOPPED: ${stopped}\n` : ""}Pulled ${firms} new firms for ${spent} credits (${cEnd.remaining} left). Raw pages: ${raw}`);
  if (stopped) process.exitCode = 2;
  stamp(dir, "source_pull", { firms, credits_spent: spent, credits_remaining: cEnd.remaining, stopped, pages: tally.reduce((n, t) => n + t.pages, 0) });
});
