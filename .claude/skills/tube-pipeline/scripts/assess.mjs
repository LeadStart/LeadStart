// Step 9: the completion assessment. Owner, 2026-09-29: "give me a thorough
// completion assessment when it's done as part of the skill". One report holds
// everything a run did:
//   1. the verdict: where the run stands and what's next;
//   2. the brief against the outcome;
//   3. every firm accounted for, step by step, each loss with its reason;
//   4. money and Scrap.io usage against the budget, the credit cap and the search ceilings;
//   5. the quality checks that ran, and what they found;
//   6. what's held or open, by name, and what each needs;
//   7. timing in the campaign: the queue, start dates, when a held scan is due;
//   8. incidents and deviations from the brief;
//   9. a comparison with the last finished run.
// It works at any step. Run it at the end of every run (--final), and whenever a
// run pauses, e.g. a scan held until nearer the send date. Read-only on the
// database. It writes <run>/assessment.md and stamps the ledger.
//
//   node .claude/skills/tube-pipeline/scripts/assess.mjs --run <name>          where it stands now
//   node .claude/skills/tube-pipeline/scripts/assess.mjs --run <name> --final  at the end of the run
import {
  ORG_ID, STEPS, addWeekdays, args, existsSync, findEnrichmentRun, fmtTally, getAll, getIn, join, listRuns, main, nextStep,
  readJson, readRun, rest, runDir, stamp, tally, writeFileSync,
} from "./lib.mjs";

const n = (x) => (x == null || !Number.isFinite(Number(x)) ? "—" : Number(x).toLocaleString("en-US"));
const usd = (x) => (x == null || !Number.isFinite(Number(x)) ? "—" : `${Number(x).toFixed(2)} dollars`);
const pct = (a, b) => (a == null || !b ? "—" : `${Math.round((100 * a) / b)}%`);
// A bare "2026-09-25" is a calendar date: read it at noon so no time zone shifts the day.
const day = (d) => (d ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? `${d}T12:00:00` : d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "—");
const when = (d) => (d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const sum = (xs, f) => xs.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const REVIEW_LABEL = {
  closed: "closed", public: "public body or nonprofit", off_vertical: "not a law firm", icp: "outside the ICP (large, national…)",
  large: "large firm (40+ lawyer emails)", owned: "already in LeadStart", second_office: "second office of a firm we kept",
};
const label = (k) => REVIEW_LABEL[k] ?? String(k).replace(/_/g, " ");
/** A held row's issue as a short kind, without names or addresses (for tallies). */
const issueKind = (t) => /^wrong person\?/i.test(t) ? "wrong person? (the address doesn't look like the owner's)"
  : String(t).replace(/"[^"]*"/g, "…").replace(/[\w.+-]+@[\w.-]+/g, "…").replace(/\s*\(the subject and body print it\)/, "").replace(/\s+/g, " ").trim();
// Each list is printed in full up to this many names, then counted.
const LIST_MAX = 25;

main(async () => {
  const a = args();
  const dir = runDir(a.run);
  const run = readRun(dir);
  const s = run.stages ?? {};
  const file = (f) => (existsSync(join(dir, f)) ? readJson(join(dir, f)) : null);
  const brief = file("brief.json");
  const counts = file("scrapio-counts.json");
  const pull = file("scrapio-pull.json");
  const excluded = file("source-excluded.json") ?? [];
  const upRep = file("upload-report.json");
  const validation = file("validation.json");
  const importPlan = file("import-plan.json");
  const importResult = file("import-result.json");
  const outcome = brief?.outcome ?? {};
  const spend = run.spend?.length ? run.spend
    : Object.entries(outcome.costs_usd ?? {}).map(([what, v]) => ({ what: `${what.replace(/_/g, " ")} (recorded after the fact)`, usd: v, at: brief?.confirmed_at }));
  const spent = sum(spend, (e) => e.usd);
  const bySkill = Boolean(s.source_count || s.source_pull || s.source_review || s.source_import);
  const u = s.upload;
  // build-upload re-run after the import counts the run's own enrolled firms as
  // "already in the target campaign": they were in the sheet, so count them back in.
  const rebuilt = Boolean(u && s.import && new Date(u.at) > new Date(s.import.at));
  const ownDrops = rebuilt ? (upRep?.dropped ?? []).filter((d) => d.reason === "in_campaign") : [];
  const sheetKept = u ? u.kept + ownDrops.length : null;
  const sheetDropped = (upRep?.dropped ?? []).filter((d) => !(rebuilt && d.reason === "in_campaign"));
  const heldRows = (validation?.results ?? []).filter((r) => r.issues?.length);
  const heldKinds = heldRows.length ? tally(heldRows.flatMap((r) => [...new Set(r.issues.map(issueKind))])) : (s.validate?.issue_kinds ?? {});
  const heldScan = brief?.pace?.scan === "hold_until_near_send";
  const campaignId = run.campaign_id ?? brief?.campaign?.id ?? null;
  const [campaign] = campaignId ? await rest(`campaigns?select=id,name,status,daily_new_leads_cap&id=eq.${campaignId}`) : [];

  // ── step states ──
  const state = [
    brief?.confirmed_at ? "done" : "to do",
    s.source_pull ? (s.source_pull.stopped ? "STOPPED" : "done") : bySkill ? "to do" : "outside the skill",
    s.source_review ? "done" : bySkill ? "to do" : "outside the skill",
    s.enrich_done ? "done" : s.enrich_start ? "running" : s.source_import ? "imported, not enriched" : bySkill ? "to do" : "outside the skill",
    u ? (u.checked_tube ? "done" : "sheet built, TuBe not checked") : "to do",
    u?.checked_tube && u.to_upload === 0 ? "done" : s.scan ? "running" : heldScan && (s.enrich_done || u) ? "held on purpose" : "to do",
    s.validate ? "done" : "to do",
    s.import ? "done" : "to do",
    s.verify ? (s.verify.with_problems ? "PROBLEMS" : "done") : "to do",
    "this report",
  ];
  const status = s.source_pull?.stopped ? "STOPPED"
    : s.verify && !s.verify.with_problems ? "COMPLETE"
    : s.verify ? "COMPLETE WITH PROBLEMS"
    : state[5] === "held on purpose" && !s.validate ? "PAUSED ON PURPOSE (scan held)"
    : "IN PROGRESS";
  const next = nextStep(run, brief);

  // ── Scrap.io usage ──
  let searches = null, ceilings = null;
  if (bySkill) {
    let log = await getAll(`scrapio_search_log?select=at,endpoint,source,detail&organization_id=eq.${ORG_ID}&detail->>run=eq.${encodeURIComponent(a.run)}&order=at.asc`);
    if (!log.length && run.started_at) {
      // Runs started before searches carried their run name: its time window.
      const until = encodeURIComponent(s.source_pull?.at ?? new Date().toISOString());
      log = await getAll(`scrapio_search_log?select=at,endpoint,source,detail&organization_id=eq.${ORG_ID}&source=like.tube-pipeline*&at=gte.${encodeURIComponent(run.started_at)}&at=lte.${until}&order=at.asc`);
    }
    searches = { used: log.length, kinds: tally(log.map((r) => r.detail?.kind ?? "search")) };
    ceilings = await rest("rpc/scrapio_search_budget", { method: "POST", body: JSON.stringify({ p_organization_id: ORG_ID }) });
  }
  const pullStubs = pull ? sum(pull.tally ?? [], (t) => t.stubs) : null;
  const plannedPages = counts?.rows ? counts.rows.reduce((t, r) => t + ["A", "B", "C"].filter((g) => Number.isFinite(r[g])).reduce((m, g) => m + Math.max(1, Math.ceil(r[g] / 50)), 0), 0) : null;

  // ── enrichment (live while running) ──
  let enrichLive = null;
  if (s.enrich_start && !s.enrich_done) {
    const id = s.enrich_start.run_id ?? (await findEnrichmentRun(dir));
    if (id) [enrichLive] = await rest(`enrichment_runs?select=id,status,phase,total_count,processed_count,cost_usd,found_names_count,found_verified_count,error_message,started_at&id=eq.${id}`);
  }

  // ── the run's firms in the campaign (after step 7) ──
  let live = null;
  if (campaign && importResult?.contact_ids?.length) {
    const ids = importResult.contact_ids;
    const enr = await getIn((l) => `campaign_enrollments?select=contact_id,status,current_step_index,last_action_at,started_at&campaign_id=eq.${campaign.id}&contact_id=in.${l}`, ids, 60);
    const sends = await getIn((l) => `native_sends?select=contact_id,step_index,status,bounced_at,sent_at&campaign_id=eq.${campaign.id}&contact_id=in.${l}`, ids, 60);
    const cons = await getIn((l) => `contacts?select=id,status&id=in.${l}`, ids, 80);
    live = {
      ids, enr, sends,
      emailed: new Set(sends.map((x) => x.contact_id)).size,
      bounced: sends.filter((x) => x.bounced_at || x.status === "bounced").length,
      replied: enr.filter((e) => e.status === "replied").length,
      unsubscribed: cons.filter((c) => c.status === "unsubscribed").length,
      byStatus: tally(enr.map((e) => e.status)),
    };
  }

  // ── timing: the campaign's queue (new people start oldest-first, one run of the sender at a time) ──
  let timing = null;
  if (campaign) {
    const waiting = await getAll(`campaign_enrollments?select=contact_id,started_at&campaign_id=eq.${campaign.id}&status=eq.active&last_action_at=is.null&order=started_at.asc`);
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const firsts = await getAll(`native_sends?select=sent_at&campaign_id=eq.${campaign.id}&step_index=eq.0&sent_at=gte.${encodeURIComponent(since)}`);
    const perDay = tally(firsts.map((x) => String(x.sent_at).slice(0, 10)));
    const days = Object.keys(perDay).length;
    const cap = campaign.daily_new_leads_cap ?? 20;
    const recent = days ? firsts.length / days : 0;
    const rate = Math.max(1, Math.min(cap, recent || cap));
    const mine = new Set((live?.enr ?? []).filter((e) => e.status === "active" && !e.last_action_at).map((e) => e.contact_id));
    const firstMine = waiting.findIndex((w) => mine.has(w.contact_id));
    timing = {
      waiting: waiting.length, mine: mine.size, cap, recent, days, rate,
      clears: addWeekdays(new Date(), waiting.length / rate),
      firstStart: firstMine >= 0 ? addWeekdays(new Date(), firstMine / rate) : null,
      lastStart: mine.size ? addWeekdays(new Date(), waiting.length / rate) : null,
    };
  }

  // ── the last finished run, for comparison ──
  const prior = listRuns().filter((r) => r.name !== a.run && (r.run.stages?.verify || r.run.stages?.import))
    .map((r) => ({ name: r.name, run: r.run, brief: existsSync(join(r.dir, "brief.json")) ? readJson(join(r.dir, "brief.json")) : null }))[0] ?? null;

  // ── the report ──
  const out = [];
  const P = (...lines) => out.push(...lines);
  const H = (t) => out.push("", `## ${t}`, "");
  const T = (head, rows) => out.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`));
  const list = (items, fmt) => {
    for (const x of items.slice(0, LIST_MAX)) P(`  - ${fmt(x)}`);
    if (items.length > LIST_MAX) P(`  - … and ${items.length - LIST_MAX} more`);
  };

  P(`# Completion assessment: run "${a.run}"`, "",
    `${a.final ? "Final" : "Interim"} · ${when(new Date())} · **${status}**${brief ? ` · ${brief.area?.state ?? ""} ${(brief.area?.metros ?? []).length} metros → "${campaign?.name ?? brief.campaign?.name ?? "?"}"` : ""}`);

  // 1. verdict
  H("1. Verdict");
  const enrolled = s.import?.enrolled ?? null;
  const pulled = s.source_pull?.firms ?? outcome.pulled ?? null;
  P(`- **Where it stands:** ${status.toLowerCase()}. ${STEPS.map((t, i) => `${i} ${t}: ${state[i]}`).filter((x, i) => i < 9).join(" · ")}.`);
  if (pulled != null) P(`- **Firms:** ${n(pulled)} pulled${s.source_review ? ` → ${n(s.source_review.kept)} kept` : ""}${s.source_import ? ` → ${n(s.source_import.inserted)} imported` : ""}${s.enrich_done ? ` → ${n(s.enrich_done.tube_ready)} TuBe-ready` : ""}${u ? ` → ${n(sheetKept)} in the sheet` : ""}${s.validate ? ` → ${n(s.validate.validated)} clean` : ""}${enrolled != null ? ` → **${n(enrolled)} enrolled** (${pct(enrolled, pulled)} of pulled)` : ""}.`);
  P(`- **Money:** ${usd(spent)} spent${brief?.budget?.total_usd != null ? ` of ${usd(brief.budget.total_usd)}${brief.budget.hard_stop ? " (hard stop)" : ""}` : ""}${s.source_pull ? ` · ${n(s.source_pull.credits_spent)} Scrap.io credits` : ""}${searches ? ` · ${n(searches.used)} Scrap.io searches` : ""}.`);
  P(`- **Next:** ${next}`);

  // 2. brief vs outcome
  if (brief) {
    H("2. The brief against the outcome");
    const rows = [];
    const ok = (b) => (b === true ? "✓" : b === false ? "✗" : "·");
    const metrosPulled = pull ? new Set((pull.tally ?? []).map((t) => t.city)).size : null;
    rows.push(["Area", `${brief.area?.state}: ${(brief.area?.metros ?? []).join(", ")}${Object.keys(brief.area?.caps ?? {}).length ? ` (caps ${fmtTally(brief.area.caps)})` : " (no caps)"}`,
      metrosPulled != null ? `${metrosPulled} of ${(brief.area?.metros ?? []).length} metros pulled` : !bySkill && outcome.pulled ? `${n(outcome.pulled)} firms pulled outside the skill` : "not pulled yet", ok(metrosPulled == null ? null : metrosPulled === (brief.area?.metros ?? []).length)]);
    rows.push(["Filters", `${brief.filters?.min_reviews}+ reviews${brief.filters?.website ? ", website" : ""}${brief.filters?.open_only ? ", open" : ""}; groups ${(brief.practice?.groups ?? []).join("+")}`,
      pull ? `pulled with ${pull.filters?.minReviews}+ reviews${pull.filters?.website ? ", website" : ""}${pull.filters?.openOnly ? ", open" : ""}` : !bySkill && outcome.pulled ? "outside the skill" : "—",
      ok(pull ? Number(pull.filters?.minReviews) === Number(brief.filters?.min_reviews) : null)]);
    if (brief.budget) rows.push(["Budget", brief.budget.total_usd != null ? `${usd(brief.budget.total_usd)}${brief.budget.hard_stop ? ", hard stop" : ""}` : "not set",
      `${usd(spent)} spent`, ok(brief.budget.total_usd == null ? null : spent <= brief.budget.total_usd)]);
    if (brief.source?.kind === "scrapio") rows.push(["Scrap.io credits", brief.source.credits_cap != null ? `cap ${n(brief.source.credits_cap)}` : "no cap",
      s.source_pull ? `${n(s.source_pull.credits_spent)} used, ${n(s.source_pull.credits_remaining)} left` : outcome.credits ? `${n(outcome.credits)} used (outside the skill)` : "not pulled yet",
      ok(s.source_pull && brief.source.credits_cap != null ? s.source_pull.credits_spent <= brief.source.credits_cap : null)]);
    if (searches) rows.push(["Scrap.io searches", `${plannedPages != null ? `about ${n(plannedPages)} pull pages` : "?"}${counts?.reused_from ? " + 0 counts (reused)" : s.source_count ? ` + ${n(s.source_count.searches)} counts` : ""}`,
      `${n(searches.used)} used (${fmtTally(searches.kinds)})`, ok(searches.used <= 100)]);
    rows.push(["Enrichment", `owner names ${brief.enrichment?.naming ? "on" : "off"}, catch-all recovery ${brief.enrichment?.catch_all_recovery ? "on" : "off"}, weak hosts ${brief.enrichment?.weak_hosts === "enrich" ? "enriched" : "set aside"}`,
      s.enrich_done ? `${n(s.enrich_done.named)} named, ${n(s.enrich_done.verified)} verified, ${n(s.enrich_done.pooled)} set aside` : s.enrich_start ? `running (${s.enrich_start.contacts} firms)` : s.source_import ? `${n(s.source_import.pooled)} set aside at import; not enriched yet` : outcome.ready_after_enrichment ? `${n(outcome.ready_after_enrichment)} TuBe-ready (outside the skill)` : "—", "·"]);
    rows.push(["Who gets emailed", `${brief.who?.personal_email_only ? "named owner, verified or published personal email" : "any address"}; ${(brief.who?.segments ?? []).join(", ")}`,
      s.validate ? `${n(s.validate.send_rows)} on TuBe's send list, ${n(s.validate.validated)} clean` : "—", "·"]);
    rows.push(["Campaign", brief.campaign?.name ?? "?", campaign ? `${campaign.name} (${campaign.status})${s.import ? `: ${n(s.import.enrolled)} enrolled` : ""}` : "—", ok(campaign ? campaign.id === brief.campaign?.id : null)]);
    rows.push(["Pace", brief.pace?.start ?? "—", state[5] === "held on purpose" ? "scan held, as planned" : s.import ? `enrolled ${day(s.import.at)}` : "—", "·"]);
    rows.push(["Flagged firms", brief.flagged === "hold" ? "hold for review" : "skip", s.validate ? `${n(s.validate.held)} held at validation` : u ? `${n((upRep?.flags ?? []).length)} flagged in the sheet` : "—", "·"]);
    T(["", "Brief", "Outcome", ""], rows);
  }

  // 3. funnel
  H("3. Every firm, step by step");
  const F = [];
  const row = (step, what, inn, outn, lost) => F.push([step, what, n(inn), n(outn), lost || ""]);
  if (counts) row("1", "Scrap.io matches", null, counts.total, `listings across the practice groups (they overlap)${counts.reused_from ? `; counted ${day(counts.at)}, reused` : ""}`);
  if (s.source_pull) row("1", "Pulled (new firms)", counts?.total, s.source_pull.firms, `${n(pullStubs)} listings we already had came back free`);
  else if (!bySkill && outcome.pulled) row("1", "Pulled (outside the skill)", null, outcome.pulled, "");
  if (s.source_review) row("2", "Kept after review", s.source_review.new_firms, s.source_review.kept, fmtTally(Object.fromEntries(Object.entries(s.source_review.dropped_by_reason ?? {}).map(([k, v]) => [label(k), v]))));
  else if (!bySkill && outcome.kept_after_review) row("2", "Kept after review (outside the skill)", outcome.pulled, outcome.kept_after_review, "");
  if (s.source_import) row("3", "Imported into LeadStart", s.source_review?.kept, s.source_import.inserted, `${n(s.source_import.skipped_duplicates)} already in Contacts`);
  if (s.source_import) row("3", "…of which set aside (weak email host)", s.source_import.inserted, s.source_import.pooled, "kept out of campaigns until released (Contacts → Enrich)");
  if (s.enrich_done) {
    row("3", "Enriched", s.enrich_start?.contacts, s.enrich_done.firms, `${n(s.enrich_done.named)} owner named · ${n(s.enrich_done.verified)} verified personal email`);
    row("3", "TuBe-ready after enrichment", s.enrich_done.firms, s.enrich_done.tube_ready, "the rest: no named owner, or no verified/published personal email");
  } else if (enrichLive) row("3", `Enrichment ${enrichLive.status}/${enrichLive.phase}`, enrichLive.total_count, enrichLive.processed_count, `${n(enrichLive.found_names_count)} names · ${n(enrichLive.found_verified_count)} verified so far`);
  else if (!bySkill && outcome.ready_after_enrichment) row("3", "TuBe-ready (outside the skill)", outcome.kept_after_review, outcome.ready_after_enrichment, "");
  if (u) {
    const skipT = tally((upRep?.handoff_skipped ?? []).map((x) => x.label ?? x.reason));
    const dropT = tally(sheetDropped.map((x) => x.label ?? x.reason));
    row("4", "In the TuBe upload sheet", u.firms, sheetKept, [fmtTally(skipT), Object.keys(dropT).length ? `dropped: ${fmtTally(dropT)}` : ""].filter((x) => x && x !== "none").join(" · ") + (rebuilt ? ` (sheet rebuilt after the import; its ${ownDrops.length} enrolled firms counted in)` : ""));
    row("5", "Scanned in TuBe", sheetKept, u.checked_tube ? u.already_scanned + ownDrops.length : null, u.checked_tube ? `${n(u.to_upload)} still to scan${u.tube_check?.errors ? ` · ${u.tube_check.errors} failed` : ""}${u.tube_check?.nopdf ? ` · ${u.tube_check.nopdf} without a PDF` : ""}` : "not checked yet");
  }
  if (s.validate) {
    row("6", "On TuBe's send list", s.validate.send_rows + s.validate.review_rows, s.validate.send_rows, `${n(s.validate.review_rows)} in TuBe's own review list`);
    row("6", "Clean after our validation", s.validate.send_rows, s.validate.validated, fmtTally(heldKinds));
  }
  if (s.import) row("7", "Enrolled in the campaign", s.import_plan?.rows ?? s.validate?.validated, s.import.enrolled, `${n(s.import.skipped)} skipped${s.import.adopted ? ` · ${n(s.import.adopted)} adopted to the client` : ""}`);
  if (s.verify) row("8", "Verified (every email rendered)", s.import?.enrolled, s.verify.contacts, `${n(s.verify.emails)} emails · ${n(s.verify.with_problems)} with problems`);
  if (F.length) T(["Step", "What", "In", "Out", "Where the rest went"], F);
  else P("Nothing has moved yet.");
  if (pull?.tally?.length) {
    P("", "Pull by metro:");
    const byCity = {};
    for (const t of pull.tally) {
      const c = (byCity[t.city] ??= { pages: 0, firms: 0, stubs: 0, credits: 0 });
      c.pages += t.pages; c.firms += t.firms; c.stubs += t.stubs; c.credits += t.credits;
    }
    T(["Metro", "New firms", "Already had", "Credits", "Pages"], Object.entries(byCity).map(([city, c]) => [city, n(c.firms), n(c.stubs), n(c.credits), n(c.pages)]));
  }

  // 4. money + usage
  H("4. Money and Scrap.io usage");
  if (spend.length) T(["Spent on", "Dollars", "When"], [...spend.map((e) => [e.what, Number(e.usd).toFixed(2), day(e.at)]), ["**Total**", `**${spent.toFixed(2)}**`, ""]]);
  else P("- No money spent yet.");
  if (brief?.budget?.total_usd != null) {
    const est = [];
    if (s.source_import && !s.enrich_start) est.push(["enrichment", (s.source_import.inserted - s.source_import.pooled) * 0.017]);
    if (enrichLive) est.push(["rest of enrichment", Math.max(0, Number(s.enrich_start?.estimate_usd ?? 0) - Number(enrichLive.cost_usd ?? 0))]);
    const toScan = u ? u.to_upload : s.enrich_done ? s.enrich_done.tube_ready : null;
    if (toScan && !s.validate) est.push(["TuBe scans (1.75¢ each, as on WA-10)", toScan * 0.0175]);
    const projected = spent + sum(est, (e) => e[1]);
    P(`- **Budget:** ${usd(brief.budget.total_usd)}${brief.budget.hard_stop ? " (hard stop)" : ""} · spent ${usd(spent)} · left ${usd(brief.budget.total_usd - spent)}`);
    if (est.length) P(`- **Projected:** ${usd(projected)} after ${est.map(([w, v]) => `${w} ≈ ${usd(v)}`).join(", ")} ${projected > brief.budget.total_usd ? "· **OVER BUDGET: raise it with the owner before the next paid step**" : "· inside the budget"}`);
  }
  if (s.source_pull) P(`- **Scrap.io credits:** ${n(s.source_pull.credits_spent)} used (${pct(s.source_pull.credits_spent, s.source_pull.firms)} of new firms charged${pull?.credits_before ? `; ${n(pull.credits_before.remaining)} → ${n(pull.credits_after?.remaining)}` : ""}). They expire 2026-10-08.`);
  if (searches) P(`- **Scrap.io searches:** ${n(searches.used)} for this run (${fmtTally(searches.kinds)}), limit 100 per run. Shared log now: ${ceilings.day}/${ceilings.limits.day} in 24 hours · ${ceilings.week}/${ceilings.limits.week} in 7 days · ${ceilings.month}/${ceilings.limits.month} in 30 days.`);
  if (pulled && spent) P(`- **Unit cost:** ${(100 * spent / pulled).toFixed(1)}¢ per pulled firm${enrolled ? ` · ${(100 * spent / enrolled).toFixed(1)}¢ per enrolled lead` : ""} (cash; the Scrap.io credits are prepaid).`);

  // 5. quality checks
  H("5. Quality checks");
  const Q = [];
  const q = (res, text, detail) => Q.push(`- ${res === true ? "✓" : res === false ? "✗" : "·"} ${text}${detail ? `: ${detail}` : ""}`);
  q(Boolean(brief?.confirmed_at), "Brief confirmed by the owner before any search or spend", brief?.confirmed_by ?? brief?.confirmed_at);
  if (searches) q(searches.used <= 100 && ceilings.left >= 0, "Scrap.io searches inside the per-run limit and the shared ceilings", `${searches.used} used`);
  if (s.source_pull) {
    const overcharged = (pull?.tally ?? []).filter((t) => t.credits > t.firms + 2);
    q(!s.source_pull.stopped, "Pull finished without a stop", s.source_pull.stopped ?? `${s.source_pull.pages} pages`);
    q(brief?.source?.credits_cap == null ? null : s.source_pull.credits_spent <= brief.source.credits_cap, "Credits inside the cap", `${n(s.source_pull.credits_spent)} of ${n(brief?.source?.credits_cap)}`);
    q(!overcharged.length, "Never charged for a firm we already had (block list)", overcharged.length ? overcharged.map((t) => `${t.city}/${t.group}`).join(", ") : `${n(pullStubs)} came back free`);
  }
  if (s.source_review) q(true, "Review exclusions applied", `${n(s.source_review.dropped)} dropped${s.source_review.forced_keep || s.source_review.forced_drop ? ` (${s.source_review.forced_keep} kept and ${s.source_review.forced_drop} dropped by hand)` : ""}`);
  if (s.source_import) q(true, "Weak email hosts set aside at import", `${n(s.source_import.pooled)} firms`);
  if (u) q(u.checked_tube ? true : null, "Checked which firms TuBe already scanned (no double billing)", u.checked_tube ? `${n(u.already_scanned + ownDrops.length)} of ${n(sheetKept)} scanned` : "not yet");
  if (u) q(true, "Integrity drops (in the campaign, same firm, other campaigns, emailed, DNC, other client, suppressed, undeliverable, pooled)", `${n(sheetDropped.length)} dropped`);
  if (s.validate) q(s.validate.reports_checked, "Every send row checked against our sheet, the export contract and its TuBe report page", `${n(s.validate.held)} held`);
  if (s.import_plan) q(s.import_plan.render_problems === 0, "Every email rendered with the live sender logic before the import", `${n(s.import_plan.render_problems)} problems`);
  if (s.import) q(s.import.read_back_ok === s.import.enrolled, "Import read back from the database and matched", `${n(s.import.read_back_ok)} of ${n(s.import.enrolled)}`);
  if (s.verify) q(!s.verify.with_problems && !s.verify.inbox_problems, "Verify: every email renders; nobody on the do-not-contact list or pooled", `${n(s.verify.emails)} emails, ${n(s.verify.with_problems)} contacts with problems`);
  if (live) q(live.bounced === 0 ? true : null, "Bounces so far", `${n(live.bounced)} of ${n(live.sends.length)} sent`);
  P(...Q);

  // 6. held + open
  H("6. Held or open, by name");
  let any = false;
  if (excluded.length) {
    any = true;
    P(`- **Dropped at review (${excluded.length})**, final unless you say otherwise:`);
    for (const [reason, items] of Object.entries(groupBy(excluded, (e) => e.reason))) {
      P(`  - ${label(reason)} (${items.length}): ${items.slice(0, LIST_MAX).map((e) => `${e.name}${e.city ? ` (${e.city})` : ""}`).join("; ")}${items.length > LIST_MAX ? `; … ${items.length - LIST_MAX} more` : ""}`);
    }
  }
  if (s.source_review?.kept_by_hand?.length) { any = true; P(`- **Kept by hand at review (${s.source_review.kept_by_hand.length})**, overruling the rules: ${s.source_review.kept_by_hand.join(", ")}`); }
  if (s.source_import?.pooled) { any = true; P(`- **Set aside as weak email hosts: ${n(s.source_import.pooled)}.** Not enriched, not emailed. Release them in Contacts → Enrich if you want them worked.`); }
  if (sheetDropped.length) { any = true; P(`- **Dropped from the sheet (${sheetDropped.length}):**`); list(sheetDropped, (d) => `${d.company} (${d.domain}): ${d.label ?? d.reason}`); }
  if (upRep?.flags?.length && !s.validate) { any = true; P(`- **Flagged in the sheet for a look (${upRep.flags.length}):**`); list(upRep.flags, (f) => `${f.company} (${f.domain}): ${f.flags.join(", ")}`); }
  if (u?.tube_check?.errors || u?.tube_check?.nopdf) { any = true; P(`- **TuBe:** ${n(u.tube_check.errors ?? 0)} failed scans (re-run needs your go) · ${n(u.tube_check.nopdf ?? 0)} reports without a PDF (answer their hot leads with the link).`); }
  if (heldRows.length) { any = true; P(`- **Held at validation (${heldRows.length})**, each needs a fix in TuBe, a re-scan you approve, or a skip:`); list(heldRows, (r) => `${r.company} (${r.domain}, ${r.segment}): ${r.issues.join(" | ")}`); }
  if (importPlan?.skipped?.length) { any = true; P(`- **Skipped at the import (${importPlan.skipped.length}):**`); list(importPlan.skipped, (x) => `${x.company} (${x.domain}): ${x.label ?? x.reason}`); }
  if (s.verify?.with_problems) { any = true; P(`- **Verify problems:** ${fmtTally(s.verify.problem_kinds ?? {})}`); }
  if (!any) P("- Nothing held or open yet.");

  // 7. timing
  H("7. Timing in the campaign");
  if (timing) {
    P(`- **Queue:** ${n(timing.waiting)} people waiting for Email 1 in "${campaign.name}" (${campaign.status}). It starts at most ${timing.cap} new people a weekday; the last ${timing.days} sending days averaged ${timing.recent.toFixed(1)} Email 1s a day, so the estimate uses ${timing.rate.toFixed(1)} a day.`);
    P(`- **The current queue clears around ${day(timing.clears)}.**`);
    if (timing.mine) P(`- **This run's firms:** ${n(timing.mine)} still waiting · first starts around ${day(timing.firstStart)} · last around ${day(timing.lastStart)}.`);
    else if (!s.import) {
      const scanBy = new Date(Math.max(Date.now(), timing.clears.getTime() - 7 * 864e5));
      P(`- **This run's firms aren't enrolled yet.** Enrolled now, they'd start after the queue, around ${day(timing.clears)}.`);
      if (heldScan) P(`- **Held scan is due around ${day(scanBy)}**: scan, export, validate and enroll then, so the AI answers the emails quote are about a week old when they send.`);
    }
    if (live) P(`- **So far:** ${n(live.emailed)} of ${n(live.ids.length)} emailed · ${n(live.replied)} replied · ${n(live.unsubscribed)} unsubscribed · ${n(live.bounced)} bounced · enrollments ${fmtTally(live.byStatus)}.`);
  } else P("- No campaign attached yet.");

  // 8. incidents + deviations
  H("8. Incidents and deviations");
  const I = [];
  if (counts?.reused_from) I.push(`Counts reused (${counts.reused_from}) instead of re-counting: saved ${n((brief?.area?.metros ?? []).length * (brief?.practice?.groups ?? ["A", "B", "C"]).length)} searches.`);
  if (s.source_pull?.stopped) I.push(`The pull STOPPED: ${s.source_pull.stopped}`);
  if (searches && plannedPages != null && searches.used > plannedPages * 1.25 + 5) I.push(`Searches ran over the plan: ${searches.used} used vs about ${plannedPages} planned.`);
  if (s.source_review?.forced_keep || s.source_review?.forced_drop) I.push(`Review overrides by hand: ${s.source_review.forced_keep} kept, ${s.source_review.forced_drop} dropped.`);
  if (s.enrich_start && s.enrich_start.status !== "started") I.push(`Enrichment didn't start straight away: ${s.enrich_start.status}.`);
  if (enrichLive?.error_message) I.push(`Enrichment error: ${enrichLive.error_message}`);
  if (brief?.budget?.total_usd != null && spent > brief.budget.total_usd) I.push(`Over budget: ${usd(spent)} spent of ${usd(brief.budget.total_usd)}.`);
  if (s.import && !s.import.read_back_ok) I.push("The import read-back did not match.");
  if (!bySkill && (outcome.pulled || u)) I.push("Steps 1–3 happened outside this skill (before it existed): their numbers come from the brief's outcome record.");
  P(...(I.length ? I.map((x) => `- ${x}`) : ["- None."]));
  P("", "Anything new that went wrong belongs in references/lessons.md, with the check that now catches it.");

  // 9. comparison
  if (prior) {
    H(`9. Against the last finished run ("${prior.name}")`);
    const po = prior.brief?.outcome ?? {};
    const ps = prior.run.stages ?? {};
    const pPulled = ps.source_pull?.firms ?? po.pulled;
    const pEnrolled = ps.import?.enrolled ?? po.enrolled;
    const pSpent = sum(prior.run.spend ?? [], (e) => e.usd) || sum(Object.values(po.costs_usd ?? {}), (v) => v);
    T(["", prior.name, a.run], [
      ["Pulled", n(pPulled), n(pulled)],
      ["TuBe-ready", n(ps.enrich_done?.tube_ready ?? po.ready_after_enrichment), n(s.enrich_done?.tube_ready)],
      ["Enrolled", n(pEnrolled), n(enrolled)],
      ["Pulled → enrolled", pct(pEnrolled, pPulled), pct(enrolled, pulled)],
      ["Cash spent", usd(pSpent || null), usd(spent)],
      ["Per enrolled lead", pEnrolled && pSpent ? `${(100 * pSpent / pEnrolled).toFixed(1)}¢` : "—", enrolled && spent ? `${(100 * spent / enrolled).toFixed(1)}¢` : "—"],
    ]);
  }

  const text = out.join("\n") + "\n";
  writeFileSync(join(dir, "assessment.md"), text);
  const final = Boolean(a.final) && status.startsWith("COMPLETE");
  stamp(dir, final ? "assess_final" : "assess", { status, next, spent: +spent.toFixed(2), enrolled, searches: searches?.used ?? null });
  console.log(text);
  if (a.final && !final) console.log(`NOT FINAL: the run isn't finished (${status}). Saved as an interim assessment. Next: ${next}`);
});

function groupBy(xs, f) {
  const m = {};
  for (const x of xs) (m[f(x)] ??= []).push(x);
  return m;
}
