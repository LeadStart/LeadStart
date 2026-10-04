// Step 7: load the validated TuBe rows into the LeadStart campaign. DRY RUN
// unless --apply.
//
//   npx tsx .claude/skills/tube-pipeline/scripts/import-campaign.mts --run <name> [--campaign <id>]
//       [--only <domain,...>] [--exclude <domain,...>] [--apply]
//
// Does what the campaign's CSV import does for an owner
// (src/app/api/campaigns/[id]/client-import/route.ts): match each row to its
// existing LeadStart contact by email; ADOPT it into the campaign's client when
// it is still an unassigned LeadStart contact, or LINK it when it is already that
// client's; merge the TuBe values into custom_fields; enroll it at the first
// email; register the columns in the campaign's variable list. It skips the
// contacts the route also leaves untouched (already in this campaign, or active
// or paused in another one), plus the checks the route doesn't make: already
// emailed, the same firm already in this campaign, set aside as a weak email host.
//
// Before anything is written, every email for every planned contact is rendered
// exactly as the live sender will (render-check.mts); a single problem refuses
// --apply. --apply backs up each touched contact first (<run>/backups/), writes,
// re-reads, and records the contact ids in import-result.json.
import { mkdirSync, writeFileSync } from "node:fs";
import {
  FREE_MAIL, ORG_ID, TUBE_CAMPAIGN, args, assertRepoCwd, count, csvList, emailDomain, existsSync, fmtTally, getAll, getIn,
  host, importRepo, join, main, readCsv, readRun, rest, runDir, stamp, tally, writeJson,
} from "./lib.mjs";

// TuBe export column → contacts.custom_fields key (same name). The campaign's
// copy reads these as {{tokens}}; see references/field-contract.md.
export const FIELD_MAP = ["firm", "business_type", "city", "competitor_1", "competitors", "question", "ai_rank",
  "ahead_of_you", "segment", "report_link", "ai_visibility", "domain_authority"];
const SKIP_LABEL: Record<string, string> = {
  not_a_contact: "Email is not a LeadStart contact",
  other_client: "Belongs to another client",
  suppressed: "Contact bounced, unsubscribed or replied before",
  undeliverable: "Verifier says undeliverable",
  dnc: "On the do-not-contact list",
  pooled: "Set aside as a weak email host (pooled-weak-host)",
  already_enrolled: "Already enrolled in this campaign",
  firm_in_campaign: "Same firm (website/email domain) already in this campaign",
  other_campaign: "Active or paused in another campaign",
  emailed_before: "Already emailed by LeadStart",
};

main(async () => {
  assertRepoCwd();
  const { checkContacts, loadCampaign, TOKEN_CONTACT_COLS } = await import("./render-check.mts");
  const { extractCampaignTokens, normalizeVarKey, reconcileCampaignVariables } = await importRepo("src/lib/native/tokens.ts");
  const { allEmailTemplates } = await importRepo("src/lib/flow/graph.ts");
  const { effectiveDailyCap } = await importRepo("src/lib/gmail/ramp.ts");
  const a = args();
  const APPLY = a.apply === true;
  const dir = runDir(a.run);
  const campaignId = typeof a.campaign === "string" ? a.campaign : readRun(dir).campaign_id ?? TUBE_CAMPAIGN;
  const ctx = await loadCampaign(campaignId);
  const campaign = ctx.campaign;
  if (!["draft", "active", "paused"].includes(campaign.status)) throw new Error(`campaign "${campaign.name}" is ${campaign.status}`);
  if (!campaign.client_id) throw new Error(`campaign "${campaign.name}" has no client`);

  // ── the validated rows ──
  const file = join(dir, "send-validated.csv");
  if (!existsSync(file)) throw new Error(`${file} not found: run validate-export.mjs first`);
  const only = new Set(csvList(a.only).map(host)), exclude = new Set(csvList(a.exclude).map(host));
  const rows = readCsv(file).filter((r: any) => (!only.size || only.has(host(r.domain))) && !exclude.has(host(r.domain)));
  if (!rows.length) throw new Error("no rows to import");

  // ── everything the checks need, in bulk ──
  const emails = [...new Set(rows.flatMap((r: any) => [r.email.trim(), r.email.trim().toLowerCase()]))];
  const contacts = await getIn((l: string) =>
    `contacts?select=${TOKEN_CONTACT_COLS},client_id,campaign_id,status,tags,email_verification_status,company_domain&organization_id=eq.${ORG_ID}&email=in.${l}`, emails);
  const byEmail = new Map(contacts.map((c: any) => [c.email.trim().toLowerCase(), c]));
  const ids = contacts.map((c: any) => c.id);
  const [dnc, enrollments, sends, campEnroll] = await Promise.all([
    getIn((l: string) => `dnc_entries?select=email,client_id&organization_id=eq.${ORG_ID}&email=in.${l}`, emails),
    getIn((l: string) => `campaign_enrollments?select=contact_id,campaign_id,status&contact_id=in.${l}`, ids),
    getIn((l: string) => `native_sends?select=to_email&to_email=in.${l}`, emails),
    getAll(`campaign_enrollments?select=contact_id,status,current_step_index&campaign_id=eq.${campaign.id}`),
  ]);
  const inCampaign = await getIn((l: string) => `contacts?select=id,email,company_domain&id=in.${l}`, campEnroll.map((e: any) => e.contact_id), 60);
  const firmDomain = (d: string) => (d && !FREE_MAIL.has(d) ? d : "");
  const campaignDomains = new Set(inCampaign.flatMap((c: any) => [host(c.company_domain), firmDomain(emailDomain(c.email))]).filter(Boolean));
  const inCampaignIds = new Set(campEnroll.map((e: any) => e.contact_id));
  const dncSet = new Set(dnc.filter((d: any) => d.client_id === null || d.client_id === campaign.client_id).map((d: any) => d.email.trim().toLowerCase()));
  const sentSet = new Set(sends.map((s: any) => String(s.to_email).trim().toLowerCase()));
  const otherActive = new Set(enrollments.filter((e: any) => e.campaign_id !== campaign.id && ["active", "paused"].includes(e.status)).map((e: any) => e.contact_id));

  // ── the plan ──
  const plan: any[] = [];
  const skipped: any[] = [];
  const seenFirm = new Set<string>();
  for (const r of rows) {
    const email = r.email.trim().toLowerCase();
    const c = byEmail.get(email);
    const skip = (reason: string) => skipped.push({ domain: host(r.domain), company: r.company, email: r.email, reason, label: SKIP_LABEL[reason] });
    if (!c) { skip("not_a_contact"); continue; }
    if (c.client_id && c.client_id !== campaign.client_id) { skip("other_client"); continue; }
    if (["bounced", "unsubscribed", "replied"].includes(c.status)) { skip("suppressed"); continue; }
    if (["invalid", "disposable"].includes(c.email_verification_status ?? "")) { skip("undeliverable"); continue; }
    if (dncSet.has(email)) { skip("dnc"); continue; }
    if ((c.tags ?? []).includes("pooled-weak-host")) { skip("pooled"); continue; }
    if (inCampaignIds.has(c.id)) { skip("already_enrolled"); continue; }
    const d = host(r.domain), ed = firmDomain(emailDomain(email));
    if (campaignDomains.has(d) || (ed && campaignDomains.has(ed)) || seenFirm.has(d)) { skip("firm_in_campaign"); continue; }
    if (otherActive.has(c.id)) { skip("other_campaign"); continue; }
    if (sentSet.has(email)) { skip("emailed_before"); continue; }
    seenFirm.add(d);
    const fields: Record<string, string> = {};
    for (const k of FIELD_MAP) if (String(r[k] ?? "").trim()) fields[k] = String(r[k]).trim();
    plan.push({ c, adopt: c.client_id === null, fields, row: r });
  }

  // ── what the copy needs vs what the rows carry ──
  const tokens = extractCampaignTokens(allEmailTemplates(campaign.flow_graph));
  const unmapped = tokens.custom.filter((t: any) => !t.hasFallback && !FIELD_MAP.some((k) => normalizeVarKey(k) === t.key));
  const nextVars = reconcileCampaignVariables(campaign.variables ?? null, tokens, FIELD_MAP.map((t) => ({ token: t, key: normalizeVarKey(t) })));
  const before = new Set((campaign.variables ?? []).map((v: any) => v.key));
  const newVars = nextVars.filter((v: any) => !before.has(v.key));

  // ── render every email for every planned contact, as it would send ──
  const planned = plan.map((p) => ({ ...p.c, custom_fields: { ...(p.c.custom_fields ?? {}), ...p.fields } }));
  const { results, inboxProblems } = checkContacts(ctx, planned);
  const bad = results.filter((r: any) => r.problems.length);

  // ── pace (rough) ──
  const waiting = campEnroll.filter((e: any) => e.status === "active" && e.current_step_index === 0).length;
  let capacity = 0;
  for (const mb of ctx.pool) {
    const sent = await count(`native_sends?select=id&mailbox_id=eq.${mb.id}`);
    capacity += effectiveDailyCap(mb, Math.max(0, sent - (mb.ramp_baseline_sent ?? 0)));
  }

  // ── report ──
  console.log(`Campaign "${campaign.name}" (${campaign.status}) · window ${campaign.send_start_hour}:00-${campaign.send_end_hour}:00 ${campaign.send_timezone}`);
  console.log(`Validated rows: ${rows.length}${only.size || exclude.size ? " (after --only/--exclude)" : ""} → enroll ${plan.length} (adopt into the client ${plan.filter((p) => p.adopt).length}, already the client's ${plan.filter((p) => !p.adopt).length}) · skip ${skipped.length}${skipped.length ? `: ${fmtTally(tally(skipped.map((s) => s.label)))}` : ""}`);
  for (const s of skipped.slice(0, 10)) console.log(`  skip · ${s.domain} (${s.company}): ${s.label}`);
  console.log(`By segment: ${fmtTally(tally(plan.map((p) => p.fields.segment ?? "?")))}`);
  console.log(`Each contact gets: ${FIELD_MAP.join(", ")} (custom fields; name, email and other contact columns are not touched)`);
  console.log(`Campaign variables: ${newVars.length ? `adds ${newVars.map((v: any) => `{{${v.token}}}`).join(" ")}` : "none new (all already registered)"}`);
  if (unmapped.length) console.log(`  WARNING: the copy uses ${unmapped.map((t: any) => `{{${t.token}}}`).join(" ")}, which TuBe's export doesn't supply`);
  console.log(`Render check: ${results.length} contacts × ${ctx.path.length} emails = ${results.length * ctx.path.length} emails · ${bad.length} contacts with problems`);
  for (const p of inboxProblems) console.log(`  inbox problem · ${p}`);
  for (const [k, n] of Object.entries(tally(results.flatMap((r: any) => r.problems.map((x: string) => x.replace(/"[^"]*"/g, "…")))))) console.log(`  problem · ${k}: ${n}`);
  for (const r of bad.slice(0, 8)) console.log(`    ${r.contact.email}: ${r.problems.join(" | ")}`);
  for (const [k, n] of Object.entries(tally(results.flatMap((r: any) => r.warnings.map((x: string) => x.replace(/"[^"]*"/g, "…").replace(/\d+ characters/, "N characters")))))) console.log(`  warning · ${k}: ${n}`);
  console.log(`Pace (rough): ${waiting} already waiting at Email 1 + ${plan.length} new. The campaign starts at most ${campaign.daily_new_leads_cap ?? "?"} new people a day, and its ${ctx.pool.length} inboxes can send ${capacity} emails a day right now (follow-ups share that).`);
  const sample = results.find((r: any) => !r.problems.length && r.contact.custom_fields?.segment === "NAMED_NOT_FIRST") ?? results.find((r: any) => !r.problems.length);
  if (sample) {
    const m = sample.mails[0];
    console.log(`\n=== sample Email 1 (${sample.contact.first_name} at ${sample.contact.custom_fields?.firm}, version ${m.variant}, from ${sample.mailbox?.email_address}) ===\nSubject: ${m.subject}\n\n${m.body}\n`);
  }
  const planFile = join(dir, "import-plan.json");
  writeJson(planFile, {
    at: new Date().toISOString(), campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
    enroll: plan.map((p) => ({ contact_id: p.c.id, email: p.c.email, adopt: p.adopt, fields: p.fields })), skipped,
    new_variables: newVars, render_problems: bad.map((r: any) => ({ email: r.contact.email, problems: r.problems })),
  });

  if (!APPLY) {
    console.log(`DRY RUN: nothing written (plan saved to import-plan.json). With the owner's go: re-run with --apply.`);
    stamp(dir, "import_plan", { rows: rows.length, enroll: plan.length, skipped: skipped.length, render_problems: bad.length });
    return;
  }
  if (bad.length || inboxProblems.length) throw new Error(`refusing --apply: ${bad.length} contacts would send a broken email${inboxProblems.length ? ` and ${inboxProblems.length} inbox problems` : ""}. Fix the data (or hold those firms with --exclude) and re-run.`);
  if (!plan.length) throw new Error("nothing to apply");

  // ── apply ──
  const stampNow = Date.now();
  mkdirSync(join(dir, "backups"), { recursive: true });
  const backupFile = join(dir, "backups", `import-${stampNow}.json`);
  writeFileSync(backupFile, JSON.stringify(plan.map((p) => ({ id: p.c.id, client_id: p.c.client_id, campaign_id: p.c.campaign_id, custom_fields: p.c.custom_fields })), null, 1));
  const done: string[] = [];
  let adopted = 0;
  for (const p of plan) {
    const guard = p.adopt ? `id=eq.${p.c.id}&client_id=is.null` : `id=eq.${p.c.id}&client_id=eq.${campaign.client_id}`;
    const out = await rest(`contacts?${guard}`, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        campaign_id: campaign.id, ...(p.adopt ? { client_id: campaign.client_id } : {}),
        custom_fields: { ...(p.c.custom_fields ?? {}), ...p.fields }, updated_at: new Date().toISOString(),
      }),
    }).catch((e: Error) => { throw new Error(`${e.message} (after ${done.length} of ${plan.length} contacts; backup ${backupFile})`); });
    if (out?.length) { done.push(p.c.id); if (p.adopt) adopted++; }
  }
  let enrolled = 0;
  for (let i = 0; i < done.length; i += 100) {
    const out = await rest(`campaign_enrollments?on_conflict=campaign_id,contact_id`, {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify(done.slice(i, i + 100).map((id) => ({ campaign_id: campaign.id, contact_id: id, current_step_index: 0, status: "active" }))),
    });
    enrolled += out?.length ?? 0;
  }
  if (newVars.length) await rest(`campaigns?id=eq.${campaign.id}`, { method: "PATCH", body: JSON.stringify({ variables: nextVars }) });

  // ── read it back ──
  const after = await getIn((l: string) => `contacts?select=id,client_id,campaign_id,custom_fields&id=in.${l}`, done, 60);
  const ok = after.filter((c: any) => c.client_id === campaign.client_id && c.campaign_id === campaign.id && FIELD_MAP.every((k) => !plan.find((p) => p.c.id === c.id)?.fields[k] || c.custom_fields?.[k] === plan.find((p) => p.c.id === c.id).fields[k])).length;
  const enr = await getIn((l: string) => `campaign_enrollments?select=contact_id&campaign_id=eq.${campaign.id}&contact_id=in.${l}`, done, 60);
  writeJson(join(dir, "import-result.json"), { at: new Date().toISOString(), campaign_id: campaign.id, contact_ids: done, adopted, linked: done.length - adopted, enrolled_now: enrolled, backup: backupFile });
  console.log(`APPLIED: ${done.length} contacts updated (adopted ${adopted}) · ${enrolled} newly enrolled · variables ${newVars.length ? `+${newVars.length}` : "unchanged"}`);
  console.log(`READ BACK: ${ok}/${done.length} on the client + campaign with every field · ${enr.length}/${done.length} enrolled · backup ${backupFile}`);
  stamp(dir, "import", { enrolled: done.length, adopted, newly_enrolled: enrolled, skipped: skipped.length, read_back_ok: ok, backup: backupFile });
  if (ok !== done.length || enr.length !== done.length || done.length !== plan.length) process.exitCode = 2;
});
