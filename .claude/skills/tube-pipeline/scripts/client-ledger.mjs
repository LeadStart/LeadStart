// The client ledger: one central file per client, kept in the repo
// (docs/clients/<slug>.md), so every computer and session sees where each
// client's campaigns stand and which cities and regions have already been
// worked. Owner, 2026-09-30: "How are you keeping track of the cities/regions
// we've already hit? ... It would be wise to have one of those for each client."
//
//   node .claude/skills/tube-pipeline/scripts/client-ledger.mjs --client <slug|id>            print it (read-only)
//   node .claude/skills/tube-pipeline/scripts/client-ledger.mjs --client <slug|id> --write    regenerate docs/clients/<slug>.md
//   node .claude/skills/tube-pipeline/scripts/client-ledger.mjs --all --write                 every active client
//   node .claude/skills/tube-pipeline/scripts/client-ledger.mjs --client <slug> --add-run <run> --write
//                                                             record a finished pipeline run (assess.mjs --final does this)
//
// docs/clients/<slug>.json holds what the database can't: each run's brief,
// counts and costs, the plan (next markets), and notes. Everything else
// (campaigns, enrollment, which cities were pulled and enrolled) is read live
// from LeadStart's database every time, so the .md is current whenever it is
// regenerated. City-level counts only: no prospect names or emails go in here.
import { pathToFileURL } from "node:url";
import {
  ORG_ID, RUNS_ROOT, args, assertRepoCwd, existsSync, getAll, getIn, join, main, mkdirSync, readJson, readRun, readdirSync, rest, writeFileSync,
} from "./lib.mjs";

const STATES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const stateCode = (s) => {
  const v = String(s ?? "").trim();
  return /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : STATES[v.toLowerCase()] ?? (v || "?");
};
const n = (x) => (x == null || !Number.isFinite(Number(x)) ? "—" : Number(x).toLocaleString("en-US"));
const usd = (x) => (x == null || !Number.isFinite(Number(x)) ? "—" : `${Number(x).toFixed(2)}`);
const day = (d) => (d ? String(d).slice(0, 10) : "—");
export const slugify = (name) => String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export const clientsDir = () => join(process.cwd(), "docs", "clients");

/** The client row for a slug or id (active or former). */
async function findClient(key) {
  const all = await rest(`clients?select=id,name,status&organization_id=eq.${ORG_ID}`);
  return all.find((c) => c.id === key || slugify(c.name) === slugify(key)) ?? null;
}

/** The ledger config (docs/clients/<slug>.json), or a fresh one. */
export function loadConfig(client) {
  const file = join(clientsDir(), `${slugify(client.name)}.json`);
  const base = { client: { id: client.id, name: client.name, slug: slugify(client.name) }, vertical: null, searches: [], runs: [], other_pulls: [], plan: { next: [], deferred: [] }, notes: [] };
  return { file, config: existsSync(file) ? { ...base, ...readJson(file) } : base };
}

/** The ledger config that belongs to a campaign's client (for the pipeline's runs). */
export async function configForCampaign(campaignId) {
  const [c] = await rest(`campaigns?select=client_id&id=eq.${campaignId}`);
  if (!c?.client_id) return null;
  const [client] = await rest(`clients?select=id,name,status&id=eq.${c.client_id}`);
  return client ? { client, ...loadConfig(client) } : null;
}

/** Record (or refresh) a finished pipeline run in the config, from its run folder. */
export function addRun(config, runName) {
  const dir = join(RUNS_ROOT, runName);
  if (!existsSync(dir)) throw new Error(`no run folder ${dir}`);
  const run = readRun(dir);
  const brief = existsSync(join(dir, "brief.json")) ? readJson(join(dir, "brief.json")) : {};
  const s = run.stages ?? {};
  const o = brief.outcome ?? {};
  const spend = (run.spend ?? []).reduce((t, e) => t + Number(e.usd || 0), 0) || Object.values(o.costs_usd ?? {}).reduce((t, v) => t + Number(v || 0), 0);
  const searchIds = run.cohort?.searches?.length ? run.cohort.searches : [];
  const entry = {
    run: runName,
    date: day(s.source_pull?.at ?? brief.confirmed_at ?? s.import?.at), // when the firms were pulled
    state: brief.area?.state ?? null,
    metros: brief.area?.metros ?? [],
    source: brief.source?.kind ?? null,
    filters: brief.filters ? `${brief.filters.min_reviews}+ reviews${brief.filters.website ? ", website" : ""}${brief.filters.open_only ? ", open" : ""}; groups ${(brief.practice?.groups ?? []).join("+")}` : null,
    campaign: brief.campaign?.name ?? run.campaign_name ?? null,
    pulled: s.source_pull?.firms ?? o.pulled ?? null,
    kept: s.source_review?.kept ?? o.kept_after_review ?? null,
    tube_ready: s.enrich_done?.tube_ready ?? o.ready_after_enrichment ?? null,
    enrolled: s.import?.enrolled ?? o.enrolled ?? null,
    held: s.validate?.held ?? o.held ?? null,
    cash_usd: spend ? +spend.toFixed(2) : null,
    credits: s.source_pull?.credits_spent ?? o.credits ?? null,
    searches_used: s.assess_final?.searches ?? s.assess?.searches ?? null,
    maps_searches: searchIds,
  };
  config.runs = [...(config.runs ?? []).filter((r) => r.run !== runName), entry].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const id of searchIds) if (!(config.searches ?? []).some((x) => x.id === id)) (config.searches ??= []).push({ id, vertical: config.vertical ?? null, run: runName });
  return entry;
}

/** Live facts from the database: campaigns, enrollment, and city coverage. */
export async function build(config) {
  const [client] = await rest(`clients?select=id,name,status&id=eq.${config.client.id}`);
  const campaigns = await rest(`campaigns?select=id,name,status,created_at&client_id=eq.${config.client.id}&order=created_at.asc`);
  const campIds = campaigns.map((c) => c.id);
  const camps = [];
  for (const c of campaigns) {
    const enr = await getAll(`campaign_enrollments?select=contact_id,status,last_action_at&campaign_id=eq.${c.id}`);
    const sends = await getAll(`native_sends?select=id,bounced_at,status&campaign_id=eq.${c.id}`);
    camps.push({
      ...c, enrolled: enr.length,
      waiting: enr.filter((e) => e.status === "active" && !e.last_action_at).length,
      inSequence: enr.filter((e) => e.status === "active" && e.last_action_at).length,
      replied: enr.filter((e) => e.status === "replied").length,
      finished: enr.filter((e) => !["active", "replied"].includes(e.status)).length,
      sent: sends.length, bounced: sends.filter((x) => x.bounced_at || x.status === "bounced").length,
    });
  }
  // The client's searches: the ones the config lists, plus any its contacts came from.
  const found = await getAll(`contacts?select=msid:enrichment_data->>maps_search_id&organization_id=eq.${ORG_ID}&client_id=eq.${config.client.id}&enrichment_data->>maps_search_id=not.is.null`);
  const listed = new Map((config.searches ?? []).map((x) => [x.id, x]));
  for (const id of new Set(found.map((r) => r.msid))) if (!listed.has(id)) listed.set(id, { id, vertical: null, discovered: true });
  const searches = [];
  const places = new Map();
  for (const meta of listed.values()) {
    const [row] = await rest(`maps_searches?select=id,created_at,query,results,saved_count&id=eq.${meta.id}`);
    if (!row) continue;
    const label = String(row.query?.name ?? meta.id.slice(0, 8));
    searches.push({ ...meta, created_at: row.created_at, name: label, saved: row.saved_count, source: row.query?.source ?? (row.query?.levers ? "apify" : null) });
    for (const p of row.results ?? []) {
      if (!p.google_place_id || places.has(p.google_place_id)) continue;
      places.set(p.google_place_id, { state: stateCode(p.state), city: String(p.city ?? "?").trim(), date: row.created_at, search: label, vertical: meta.vertical ?? "unassigned" });
    }
  }
  // Which of those places are enrolled in one of the client's campaigns.
  const enrolledPlaces = new Set();
  if (places.size && campIds.length) {
    const contacts = await getIn((l) => `contacts?select=id,google_place_id&organization_id=eq.${ORG_ID}&google_place_id=in.${l}`, [...places.keys()], 80);
    const byContact = new Map(contacts.map((c) => [c.id, c.google_place_id]));
    const enr = await getIn((l) => `campaign_enrollments?select=contact_id&campaign_id=in.(${campIds.join(",")})&contact_id=in.${l}`, [...byContact.keys()], 80);
    for (const e of enr) enrolledPlaces.add(byContact.get(e.contact_id));
  }
  // Contacts that came from imported lists (not map searches): by the city in
  // their own fields, a city/state column or an address "…, City, ST 12345".
  const own = await getAll(`contacts?select=id,cf:custom_fields,msid:enrichment_data->>maps_search_id&organization_id=eq.${ORG_ID}&client_id=eq.${config.client.id}`);
  const listed2 = own.filter((c) => !c.msid);
  const listCity = new Map();
  for (const c of listed2) {
    const f = c.cf ?? {};
    let city = f.city ?? f.City ?? null, st = f.state ?? f.State ?? null;
    if (!city) {
      const m = String(f.PropertyAddressFull ?? f.PropertyAddress ?? f.full_address ?? f.address ?? f.Address ?? "").match(/,\s*([^,]+?),?\s+([A-Z]{2})\s+\d{5}/);
      if (m) { city = m[1].trim(); st = m[2]; }
    }
    if (city) listCity.set(c.id, { state: stateCode(st), city: String(city).trim() });
  }
  const listEnrolled = new Set();
  if (listCity.size && campIds.length) {
    const enr = await getIn((l) => `campaign_enrollments?select=contact_id&campaign_id=in.(${campIds.join(",")})&contact_id=in.${l}`, [...listCity.keys()], 80);
    for (const e of enr) listEnrolled.add(e.contact_id);
  }
  const lists = new Map();
  for (const [id, p] of listCity) {
    const k = `${p.state}|${p.city}`;
    const c = lists.get(k) ?? { state: p.state, city: p.city, contacts: 0, enrolled: 0 };
    c.contacts++;
    if (listEnrolled.has(id)) c.enrolled++;
    lists.set(k, c);
  }
  const listSummary = { total: listed2.length, located: listCity.size, rows: [...lists.values()] };

  const coverage = new Map();
  for (const [pid, p] of places) {
    const k = `${p.vertical}|${p.state}|${p.city}`;
    const c = coverage.get(k) ?? { vertical: p.vertical, state: p.state, city: p.city, pulled: 0, enrolled: 0, first: p.date, last: p.date, searches: new Set() };
    c.pulled++;
    if (enrolledPlaces.has(pid)) c.enrolled++;
    if (p.date < c.first) c.first = p.date;
    if (p.date > c.last) c.last = p.date;
    c.searches.add(p.search);
    coverage.set(k, c);
  }
  return { client, camps, searches, coverage: [...coverage.values()], lists: listSummary };
}

/** The ledger as markdown. */
export function render(config, data) {
  const out = [];
  const P = (...l) => out.push(...l);
  const T = (head, rows) => out.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`));
  const slug = config.client.slug ?? slugify(config.client.name);
  P(`# ${data.client?.name ?? config.client.name}: client ledger`, "",
    `> Generated ${new Date().toISOString().slice(0, 10)} from LeadStart's database and \`${slug}.json\`. Don't edit this file by hand: edit the JSON (plan, notes, search verticals), then regenerate with \`node .claude/skills/tube-pipeline/scripts/client-ledger.mjs --client ${slug} --write\`.`, "",
    `**Status:** ${data.client?.status ?? "?"}${config.vertical ? ` · **Vertical:** ${config.vertical}` : ""}`);

  P("", "## Campaigns", "");
  if (data.camps.length) T(["Campaign", "Status", "Enrolled", "Waiting for Email 1", "In sequence", "Replied", "Finished", "Emails sent", "Bounced"],
    data.camps.map((c) => [c.name, c.status, n(c.enrolled), n(c.waiting), n(c.inSequence), n(c.replied), n(c.finished), n(c.sent), n(c.bounced)]));
  else P("No campaigns yet.");

  P("", "## Markets covered", "", "Every firm pulled for this client, by city (deduplicated across searches), and how many are enrolled in its campaigns. A city here has been searched: don't search it again unless the owner asks.", "");
  if (!data.coverage.length && !data.lists?.rows.length) P("No searches or located contacts recorded yet.", "");
  const byVertical = new Map();
  for (const c of data.coverage) (byVertical.get(c.vertical) ?? byVertical.set(c.vertical, []).get(c.vertical)).push(c);
  for (const [vertical, rows] of byVertical) {
    const states = [...new Set(rows.map((r) => r.state))].sort();
    P(`### ${vertical === "unassigned" ? "Unassigned searches (give them a vertical in the JSON)" : vertical}`, "");
    for (const st of states) {
      const rs = rows.filter((r) => r.state === st).sort((a, b) => b.pulled - a.pulled);
      const pulled = rs.reduce((t, r) => t + r.pulled, 0), enrolled = rs.reduce((t, r) => t + r.enrolled, 0);
      const main = rs.filter((r) => r.pulled >= 5);
      P(`**${st}:** ${n(rs.length)} cities · ${n(pulled)} firms pulled · ${n(enrolled)} enrolled`, "");
      T(["City", "Firms pulled", "Enrolled", "First pulled", "Last pulled"], main.map((r) => [r.city, n(r.pulled), n(r.enrolled), day(r.first), day(r.last)]));
      const small = rs.filter((r) => r.pulled < 5);
      if (small.length) P("", `Plus ${small.length} smaller places (under 5 firms each): ${small.map((r) => `${r.city} ${r.pulled}`).join(", ")}.`);
      P("");
    }
  }

  if (data.lists?.rows.length) {
    const L = data.lists;
    P(`### Imported lists (by each contact's own city)`, "", `${n(L.total)} contacts came from imported lists; ${n(L.located)} have a city in their own fields (a city column, or an address).`, "");
    for (const st of [...new Set(L.rows.map((r) => r.state))].sort()) {
      const rs = L.rows.filter((r) => r.state === st).sort((a, b) => b.contacts - a.contacts);
      const main = rs.filter((r) => r.contacts >= 10);
      P(`**${st}:** ${n(rs.length)} cities · ${n(rs.reduce((t, r) => t + r.contacts, 0))} contacts · ${n(rs.reduce((t, r) => t + r.enrolled, 0))} enrolled`, "");
      T(["City", "Contacts", "Enrolled"], main.map((r) => [r.city, n(r.contacts), n(r.enrolled)]));
      const small = rs.filter((r) => r.contacts < 10);
      if (small.length) P("", `Plus ${small.length} smaller places (under 10 contacts each), ${n(small.reduce((t, r) => t + r.contacts, 0))} contacts in all.`);
      P("");
    }
  }

  P("## Pipeline runs", "");
  if ((config.runs ?? []).length) T(["Run", "Date", "Area", "Pulled", "Kept", "TuBe-ready", "Enrolled", "Held", "Cash (dollars)", "Per enrolled lead", "Scrap.io credits"],
    config.runs.map((r) => [r.run, r.date, `${r.state ?? "?"}: ${(r.metros ?? []).length} metros`, n(r.pulled), n(r.kept), n(r.tube_ready), n(r.enrolled), n(r.held), usd(r.cash_usd), r.cash_usd && r.enrolled ? `${(100 * r.cash_usd / r.enrolled).toFixed(1)}¢` : "—", n(r.credits)]));
  else P("No pipeline runs recorded.");
  for (const r of config.runs ?? []) if ((r.metros ?? []).length) P(`- **${r.run}** (${r.state}): ${r.metros.join(", ")}${r.filters ? `. ${r.filters}` : ""}${r.campaign ? ` → "${r.campaign}"` : ""}`);

  P("", "## Searches", "");
  if (data.searches.length) T(["Date", "Search", "Source", "Firms saved", "Vertical", "Run"],
    data.searches.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((x) => [day(x.created_at), x.name, x.source ?? "—", n(x.saved), x.vertical ?? "unassigned", x.run ?? "—"]));
  else P("None.");

  const plan = config.plan ?? {};
  P("", "## Plan: next markets", "");
  P(...((plan.next ?? []).length ? plan.next.map((x) => `- ${typeof x === "string" ? x : `**${x.market}**${x.size ? ` (${x.size})` : ""}${x.notes ? `: ${x.notes}` : ""}`}`) : ["- Nothing planned yet."]));
  if ((plan.deferred ?? []).length) P("", "Deferred or ruled out:", ...plan.deferred.map((x) => `- ${x}`));
  if ((config.notes ?? []).length) P("", "## Notes", "", ...config.notes.map((x) => `- ${x}`));
  P("", "## How this file is kept", "",
    "- The TuBe pipeline's step 9 (`assess.mjs --final`) records each finished run in the JSON and regenerates this file.",
    "- Commit and push both files after a run, so every computer sees them.",
    "- Campaign, enrollment and coverage numbers are read live from the database whenever the file is regenerated.");
  return out.join("\n") + "\n";
}

/** Write the config (JSON) and the rendered ledger (markdown). */
export async function write(config, file) {
  mkdirSync(clientsDir(), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 1) + "\n");
  const md = render(config, await build(config));
  writeFileSync(file.replace(/\.json$/, ".md"), md);
  return md;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(async () => {
    assertRepoCwd();
    const a = args();
    const keys = a.all ? (await rest(`clients?select=id,name&organization_id=eq.${ORG_ID}&status=eq.active`)).map((c) => c.id) : [a.client];
    if (!keys[0]) throw new Error("--client <slug|id> or --all");
    for (const key of keys) {
      const client = await findClient(key);
      if (!client) throw new Error(`no client "${key}"`);
      const { file, config } = loadConfig(client);
      if (typeof a["add-run"] === "string") {
        const e = addRun(config, a["add-run"]);
        console.log(`recorded run ${e.run}: ${e.state} ${e.metros.length} metros, ${e.enrolled} enrolled, ${e.cash_usd} dollars`);
      }
      if (a.write) {
        await write(config, file);
        console.log(`wrote ${file} and ${file.replace(/\.json$/, ".md")}`);
      } else console.log(render(config, await build(config)));
    }
    if (!existsSync(clientsDir())) return;
    if (a.write) console.log(`Clients with a ledger: ${readdirSync(clientsDir()).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).join(", ")}`);
  });
}
