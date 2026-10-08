// Bank pull: grab as many businesses as the search budget allows before the
// Scrap.io credits expire, city by city, with no count searches first. Owner,
// 2026-10-07: "grab as many contacts as we can within our export limit first so
// we can cancel the subscription tomorrow"; enrichment comes later.
//
//   node .claude/skills/tube-pipeline/scripts/bank-pull.mjs --run <name>        the plan (nothing sent to Scrap.io)
//   node .claude/skills/tube-pipeline/scripts/bank-pull.mjs --run <name> --go   pull until this process's limit, then stop
//
// The brief (<run>/brief.json, mode "bank") lists the cities in order and the
// search groups, each with its own review floor. The pull walks the cities in
// that order, every group's pages to the end, and stops at whichever comes
// first: source.searches_cap for the whole run, source.credits_cap, the shared
// search log's ceilings, or RUN_LIMIT for one process. Its position (city,
// group, cursor) is saved after every page in bank-state.json, so the next
// --go resumes on the exact next page: nothing is searched twice.
//
// Every search goes through scrapio.mjs's sc(), which claims a slot in the
// shared search log first and stops on the first 403/429. The block list is
// synced first and grows after every page, so no business is paid for twice.
// Raw pages go to <run>/scrapio-raw.jsonl. Nothing is written to LeadStart.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ORG_ID, RUNS_ROOT, StopError, args, getAll, join, main, readJson, runDir, sleep, stamp } from "./lib.mjs";
import { BLOCKLIST, RUN_LIMIT, credits, fmtBudget, isFirmDomain, pushBlock, sc, searchBudget, searchPairs, webHost } from "./scrapio.mjs";

const SYNC_FILE = join(RUNS_ROOT, ".scrapio-blocklist-sync.json");
const FIRST_SYNC_FROM = "2026-09-26T00:00:00Z";

main(async () => {
  const a = args();
  const dir = runDir(a.run);
  const briefFile = join(dir, "brief.json");
  if (!existsSync(briefFile)) throw new Error(`No brief for run "${a.run}".`);
  const brief = readJson(briefFile);
  if (!brief.confirmed_at) throw new Error(`Run "${a.run}": the brief isn't confirmed by the owner yet.`);
  if (brief.mode !== "bank") throw new Error(`Run "${a.run}" isn't a bank run (brief.mode is ${JSON.stringify(brief.mode)}): use source-pull.mjs.`);
  const cities = brief.area?.cities ?? [];
  if (!cities.length || cities.some((c) => !c.city || !/^[A-Z]{2}$/.test(c.state ?? ""))) throw new Error("brief.area.cities needs [{city, state}] with 2-letter states.");
  const groups = Object.entries(brief.groups ?? {});
  if (!groups.length || groups.some(([, g]) => !g.types?.length || g.types.length > 5 || !Number.isFinite(g.min_reviews))) {
    throw new Error("brief.groups needs {name: {types: [1-5 Scrap.io types], min_reviews}}.");
  }
  const searchesCap = Number(brief.source?.searches_cap);
  const creditCap = Number(brief.source?.credits_cap);
  if (!Number.isFinite(searchesCap) || !Number.isFinite(creditCap)) throw new Error("brief.source needs searches_cap and credits_cap (the owner's numbers).");
  const website = brief.filters?.website !== false, openOnly = brief.filters?.open_only !== false;

  const stateFile = join(dir, "bank-state.json");
  const st = existsSync(stateFile)
    ? readJson(stateFile)
    : { ci: 0, gi: 0, cursor: null, page: 0, searches_used: 0, credits_spent: 0, synced: false, tally: [] };
  const save = () => writeFileSync(stateFile, JSON.stringify(st, null, 1));
  const done = st.ci >= cities.length;
  const where = done ? "every city done" : `${cities[st.ci].city}, ${cities[st.ci].state} · ${groups[st.gi][0]}${st.cursor ? ` · page ${st.page + 1}` : ""}`;

  const b = await searchBudget();
  if (a.go !== true) {
    console.log(`Run "${a.run}": bank pull plan (nothing sent to Scrap.io)`);
    console.log(`  Cities in order (${cities.length}): ${cities.map((c) => `${c.city} ${c.state}`).join(", ")}`);
    for (const [name, g] of groups) console.log(`  Group ${name}: ${g.types.join(", ")} · ${g.min_reviews}+ reviews${website ? " · website" : ""}${openOnly ? " · open" : ""}`);
    console.log(`  Caps: ${searchesCap} searches and ${creditCap} credits for the run · used so far ${st.searches_used} searches, ${st.credits_spent} credits`);
    console.log(`  Search log: ${fmtBudget(b)} → ${b.left} fit in this process (at most ${RUN_LIMIT})`);
    console.log(`  Next page: ${where}`);
    return;
  }
  if (done) return console.log("Every city in the brief is done. Nothing sent.");

  const allowed = Math.min(b.left, searchesCap - st.searches_used);
  if (allowed <= 0) throw new StopError(`REFUSED before any search: ${st.searches_used}/${searchesCap} run searches used; ${fmtBudget(b)}.`);
  const c0 = await credits();
  console.log(`Pulling up to ${allowed} searches from ${where}. Credits: ${c0.remaining} left. Search log: ${fmtBudget(b)}.`);

  if (!st.synced) {
    const since = existsSync(SYNC_FILE) ? JSON.parse(readFileSync(SYNC_FILE, "utf8")).last_sync : FIRST_SYNC_FROM;
    const syncStart = new Date().toISOString();
    const recent = await getAll(`contacts?select=google_place_id,company_domain&organization_id=eq.${ORG_ID}&created_at=gte.${since}`);
    const ids = [...new Set(recent.map((r) => r.google_place_id).filter(Boolean))];
    const doms = [...new Set(recent.map((r) => String(r.company_domain ?? "").toLowerCase().replace(/^www\./, "")).filter(isFirmDomain))];
    console.log(`Block list "${BLOCKLIST}": syncing ${ids.length} place ids + ${doms.length} domains added since ${since}`);
    await pushBlock("place_id", ids);
    await pushBlock("domain", doms);
    writeFileSync(SYNC_FILE, JSON.stringify({ last_sync: syncStart }, null, 1));
    const c1 = await credits();
    if (c1.consumed !== c0.consumed) throw new Error(`The block-list sync moved credits (${c0.consumed} → ${c1.consumed}). Stop and tell the owner.`);
    st.synced = true;
    save();
  }

  const raw = join(dir, "scrapio-raw.jsonl");
  let prev = c0.consumed, sent = 0, stopped = null;
  const row = (city, g) => {
    let t = st.tally.find((x) => x.city === city && x.group === g);
    if (!t) st.tally.push((t = { city, group: g, matches: null, pages: 0, rows: 0, stubs: 0, firms: 0, credits: 0 }));
    return t;
  };
  outer: while (st.ci < cities.length) {
    const { city, state } = cities[st.ci];
    const [g, grp] = groups[st.gi];
    const t = row(`${city}, ${state}`, g);
    if (sent >= allowed) { stopped = `paused at ${city}/${g} page ${st.page + 1}: this process's ${allowed} searches are used`; break; }
    // The owner's yield check: after N searches, stop unless they averaged enough new businesses.
    const my = brief.source?.min_yield;
    if (my && !st.yield_ok && st.searches_used >= my.after) {
      const per = st.tally.reduce((n, x) => n + x.firms, 0) / st.searches_used;
      if (per < my.per_search) { stopped = `yield check: ${per.toFixed(1)} new businesses per search over the first ${st.searches_used}, below ${my.per_search}`; break; }
      st.yield_ok = true;
    }
    if (st.credits_spent >= creditCap) { stopped = `credit cap ${creditCap} reached`; break; }
    let r;
    try {
      r = await sc("/gmap/search", [
        ...searchPairs({ state, city, types: grp.types, minReviews: grp.min_reviews, website, openOnly }),
        // Main category only (lessons #23): skips side-category matches and the overlap between groups.
        ...(grp.main_only ? [["gmap_is_main_type", "1"]] : []),
        // An upper review limit keeps out the businesses an earlier pull took above it.
        ...(Number.isFinite(grp.max_reviews) ? [["gmap_reviews_count_lte", String(grp.max_reviews)]] : []),
        ["per_page", "50"],
        ...(st.cursor ? [["cursor", st.cursor]] : []),
      ]);
    } catch (e) {
      if (!(e instanceof StopError)) throw e;
      stopped = `${city}/${g} page ${st.page + 1}: ${e.message}`;
      break;
    }
    sent++;
    st.searches_used++;
    if (r.status !== 200 && r.status !== 202) { save(); stopped = `${city}/${g} page ${st.page + 1}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`; break; }
    const rows = r.body?.data ?? [];
    st.page++;
    appendFileSync(raw, JSON.stringify({ city, state, group: g, page: st.page, http: r.status, meta: r.body?.meta, data: rows }) + "\n");
    const real = rows.filter((p) => p.blacklisted !== true);
    if (grp.main_only) {
      // The filter's name is from an old reference build: prove Scrap.io applied it.
      const mainOf = (p) => {
        const t = (p.types ?? []).filter((x) => !x.deleted);
        return (t.find((x) => x.is_main) ?? t[0] ?? {}).type;
      };
      const off = real.filter((p) => !grp.types.includes(mainOf(p)));
      if (off.length) { save(); stopped = `${city}/${g} page ${st.page}: main-category filter NOT applied (${off.length}/${real.length} rows have another main category)`; break; }
    }
    const now = (await credits()).consumed;
    const cost = now - prev;
    prev = now;
    if (t.matches === null) t.matches = Number(r.body?.meta?.count ?? NaN);
    t.pages++;
    t.rows += rows.length;
    t.stubs += rows.length - real.length;
    t.firms += real.length;
    t.credits += cost;
    st.credits_spent += cost;
    if (cost > real.length + 2) { save(); stopped = `${city}/${g} page ${st.page}: charged ${cost} credits for ${real.length} new businesses`; break; }
    const ids = real.map((p) => p.place_id).filter(Boolean);
    const doms = [...new Set(real.map((p) => webHost(p.website ?? "")).filter(isFirmDomain))];
    if (ids.length) await pushBlock("place_id", ids);
    if (doms.length) await pushBlock("domain", doms);
    st.cursor = r.body?.meta?.next_cursor ?? null;
    if (!st.cursor || rows.length === 0) {
      console.log(`  ${`${city}, ${state}`.padEnd(20)} ${g}: ${t.pages} pages · ${t.firms} new + ${t.stubs} already ours (of ${t.matches} matches) · ${t.credits} credits · run total ${st.credits_spent}`);
      st.cursor = null;
      st.page = 0;
      if (++st.gi >= groups.length) { st.gi = 0; st.ci++; }
    }
    save();
    await sleep(600);
  }
  save();
  const cEnd = await credits();
  const firms = st.tally.reduce((n, x) => n + x.firms, 0);
  writeFileSync(join(dir, "scrapio-pull.json"), JSON.stringify({ at: new Date().toISOString(), mode: "bank", groups: brief.groups, credits_after: cEnd, searches_used: st.searches_used, credits_spent: st.credits_spent, stopped, tally: st.tally }, null, 1));
  const next = st.ci < cities.length ? `${cities[st.ci].city}, ${cities[st.ci].state} · ${groups[st.gi][0]}${st.cursor ? ` · page ${st.page + 1}` : ""}` : "every city done";
  console.log(`${stopped ? `STOPPED: ${stopped}\n` : ""}This process: ${sent} searches. Run so far: ${firms} new businesses, ${st.credits_spent} credits, ${st.searches_used}/${searchesCap} searches. Scrap.io: ${cEnd.remaining} credits left. Next page: ${next}. Raw pages: ${raw}`);
  stamp(dir, "source_pull", { mode: "bank", firms, credits_spent: st.credits_spent, credits_remaining: cEnd.remaining, searches_used: st.searches_used, stopped, next });
  if (stopped && !/^paused/.test(stopped)) process.exitCode = 2;
});
