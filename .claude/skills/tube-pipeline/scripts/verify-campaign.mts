// Step 8: render every email for the campaign's contacts exactly as the live
// sender will, and list anything that would read wrong. Read-only.
//
//   npx tsx .claude/skills/tube-pipeline/scripts/verify-campaign.mts [--campaign <id>] [--run <name>] [--show <n>]
//
// --run limits the check to the contacts that run imported (import-result.json);
// without it every contact enrolled in the campaign is checked. Also re-checks
// each one's standing: still enrolled, not on the do-not-contact list, not
// pooled, not bounced/unsubscribed. Exits 2 when there are problems.
import { args, assertRepoCwd, existsSync, fmtTally, getAll, getIn, join, main, ORG_ID, readJson, readRun, runDir, stamp, tally, TUBE_CAMPAIGN } from "./lib.mjs";

main(async () => {
  assertRepoCwd();
  const { checkContacts, loadCampaign, TOKEN_CONTACT_COLS } = await import("./render-check.mts");
  const a = args();
  const dir = typeof a.run === "string" ? runDir(a.run) : null;
  const campaignId = typeof a.campaign === "string" ? a.campaign : (dir && readRun(dir).campaign_id) || TUBE_CAMPAIGN;
  const ctx = await loadCampaign(campaignId);
  const c = ctx.campaign;

  let ids: string[];
  if (dir) {
    const f = join(dir, "import-result.json");
    if (!existsSync(f)) throw new Error(`${f} not found: this run hasn't imported anything yet`);
    ids = readJson(f).contact_ids;
  } else {
    ids = (await getAll(`campaign_enrollments?select=contact_id&campaign_id=eq.${c.id}`)).map((e: any) => e.contact_id);
  }
  const contacts = await getIn((l: string) => `contacts?select=${TOKEN_CONTACT_COLS},status,tags,client_id,campaign_id&id=in.${l}`, ids, 60);
  const enr = await getIn((l: string) => `campaign_enrollments?select=contact_id,status,current_step_index&campaign_id=eq.${c.id}&contact_id=in.${l}`, ids, 60);
  const dnc = await getIn((l: string) => `dnc_entries?select=email,client_id&organization_id=eq.${ORG_ID}&email=in.${l}`,
    [...new Set(contacts.flatMap((x: any) => [x.email, String(x.email ?? "").toLowerCase()]))]);
  const dncSet = new Set(dnc.filter((d: any) => d.client_id === null || d.client_id === c.client_id).map((d: any) => d.email.trim().toLowerCase()));
  const enrBy = new Map(enr.map((e: any) => [e.contact_id, e]));

  const { results, inboxProblems } = checkContacts(ctx, contacts);
  for (const r of results) {
    const x = r.contact;
    const e = enrBy.get(x.id);
    // Only a contact the sender can still email makes a DNC or pool tag a problem;
    // a replied/completed enrollment has stopped (e.g. a "no thanks" opt-out).
    const live = e && ["active", "paused"].includes(e.status);
    if (!e) r.problems.push("not enrolled in the campaign");
    else if (!live) r.warnings.push(`enrollment is ${e.status} (no more emails)`);
    if (x.client_id !== c.client_id) r.problems.push("contact is not on the campaign's client");
    if (dncSet.has(String(x.email).trim().toLowerCase())) (live ? r.problems : r.warnings).push("on the do-not-contact list");
    if ((x.tags ?? []).includes("pooled-weak-host")) (live ? r.problems : r.warnings).push("tagged pooled-weak-host (the sender will fail it)");
    if (["bounced", "unsubscribed"].includes(x.status)) r.warnings.push(`contact status is ${x.status}`);
  }
  const missing = ids.length - contacts.length;
  const bad = results.filter((r) => r.problems.length);
  const emails = results.reduce((n, r) => n + r.mails.length, 0);
  const problemKinds = tally(results.flatMap((r) => r.problems.map((p) => p.replace(/"[^"]*"/g, "…"))));
  const warnKinds = tally(results.flatMap((r) => r.warnings.map((p) => p.replace(/"[^"]*"/g, "…").replace(/\d+ characters/, "N characters"))));

  console.log(`"${c.name}" (${c.status}) · ${ctx.path.length} emails on the main path · inboxes: ${ctx.pool.map((m: any) => m.email_address).join(", ") || "none"}`);
  console.log(`Variables the copy needs: ${[...ctx.tokens.standard, ...ctx.tokens.custom].map((t: any) => `{{${t.token}}}`).join(" ")}`);
  console.log(`Checked ${results.length} contacts${dir ? ` imported by run "${a.run}"` : " enrolled"} · ${emails} emails rendered · ${bad.length} contacts with problems${missing ? ` · ${missing} contact ids not found` : ""}`);
  console.log(`Email 1 versions: ${fmtTally(tally(results.map((r) => r.mails[0]?.variant ?? "?")))}`);
  for (const p of inboxProblems) console.log(`  inbox problem · ${p}`);
  for (const [k, n] of Object.entries(problemKinds)) console.log(`  problem · ${k}: ${n}`);
  for (const r of bad.slice(0, 10)) console.log(`    ${r.contact.email}: ${r.problems.join(" | ")}`);
  for (const [k, n] of Object.entries(warnKinds)) console.log(`  warning · ${k}: ${n}`);
  const show = Math.max(0, Number(a.show ?? 1));
  for (const r of results.filter((x) => !x.problems.length).slice(0, show)) {
    console.log(`\n=== sample: ${r.contact.first_name} <${r.contact.email}>, sent from ${r.mailbox?.email_address} ===`);
    for (const m of r.mails) console.log(`--- Email ${m.n}${m.variant !== "A" ? ` (version ${m.variant})` : ""}\nSubject: ${m.subject}\n\n${m.body}\n`);
  }
  if (dir) stamp(dir, "verify", { contacts: results.length, emails, with_problems: bad.length, inbox_problems: inboxProblems.length, problem_kinds: problemKinds });
  if (bad.length || inboxProblems.length || missing) process.exitCode = 2;
});
