// Render a campaign's emails for a contact exactly as the live sender does
// (src/app/api/cron/run-native-sequences/route.ts, flow path: sticky A/B variant
// → spintax with the same seed keys → {{tokens}} from buildTokenMap with the
// sending inbox's name + signature → blank fail-safe), then list what would read
// wrong. Copy-agnostic on purpose: the owner edits copy in the app, so nothing
// here expects particular wording. It checks values, leftover tokens, names,
// scores, the opt-out line and the signature.
import { importRepo, rest } from "./lib.mjs";

const { applyTokens, buildTokenMap, extractCampaignTokens, resolveSignature } = await importRepo("src/lib/native/tokens.ts");
const { renderSpintax } = await importRepo("src/lib/spintax/index.ts");
const { pickVariant } = await importRepo("src/lib/flow/variants.ts");
const { allEmailTemplates, flattenPrimaryPath } = await importRepo("src/lib/flow/graph.ts");
const { firstPrimaryEmail } = await importRepo("src/lib/flow/runtime.ts");

export const TOKEN_CONTACT_COLS = "id,first_name,last_name,company_name,title,intro_line,email,phone,custom_fields";
const LEGAL_END = /(,\s*|\s+)(pllc|p\.l\.l\.c\.?|pllp|llp|l\.l\.p\.?|llc|l\.l\.c\.?|inc\.?|ltd\.?|p\.\s?s\.?|ps|p\.\s?c\.?|pc|esq\.?|attorneys? at law)\s*$/i;
// CAN-SPAM + owner rule 2026-09-28: an opt-out on every email. Wording-agnostic.
const OPT_OUT = /no thanks|unsubscribe|opt[ -]?out|remove (you|me)|stop (emailing|hearing)|last you'?ll hear/i;

export async function loadCampaign(campaignId: string) {
  const [c] = await rest(
    `campaigns?select=id,name,status,client_id,flow_graph,variables,daily_new_leads_cap,sending_strategy,send_start_hour,send_end_hour,send_timezone&id=eq.${campaignId}`,
  );
  if (!c) throw new Error(`campaign ${campaignId} not found`);
  if (!c.flow_graph?.nodes?.length) throw new Error(`campaign "${c.name}" has no flow graph; this check renders flow campaigns only`);
  const path = flattenPrimaryPath(c.flow_graph.nodes).filter((n: any) => n.kind === "email");
  const tokens = extractCampaignTokens(allEmailTemplates(c.flow_graph));
  const poolIds = (await rest(`campaign_mailboxes?select=mailbox_id&campaign_id=eq.${c.id}`)).map((p: any) => p.mailbox_id);
  const pool = poolIds.length ? await rest(`native_mailboxes?select=*&id=in.(${poolIds.join(",")})`) : [];
  return { campaign: c, path, tokens, pool, first: firstPrimaryEmail(c.flow_graph) };
}

const senderName = (mb: any) => (mb?.display_name ?? "").trim() || String(mb?.email_address ?? "").split("@")[0];

export function renderContact(ctx: any, contact: any, mailbox: any) {
  const map = buildTokenMap(contact, senderName(mailbox), mailbox?.signature ?? null);
  const live = (t: string, key: string) => applyTokens(renderSpintax(t ?? "", key), map, () => "").trim();
  const keep = (t: string, key: string) => applyTokens(renderSpintax(t ?? "", key), map).trim();
  const firstVariant = ctx.first ? pickVariant(ctx.first, contact.id) : null;
  const firstSubject = firstVariant ? live(firstVariant.subject, `${contact.id}:0:subject`) : "";
  const mails = ctx.path.map((node: any, i: number) => {
    const v = pickVariant(node, contact.id);
    const subjKey = `${contact.id}:${i}:subject`, bodyKey = `${contact.id}:${i}:body`;
    const ownSubject = (v.subject ?? "").trim();
    const subject = i === 0 ? live(v.subject, `${contact.id}:0:subject`)
      : ownSubject ? live(v.subject, subjKey)
      : firstSubject.toLowerCase().startsWith("re:") ? firstSubject : `Re: ${firstSubject || "(no subject)"}`;
    return {
      n: i + 1, variant: v.label, subject, body: live(v.body, bodyKey),
      unresolved: `${i === 0 || ownSubject ? keep(v.subject, i === 0 ? `${contact.id}:0:subject` : subjKey) : ""}\n${keep(v.body, bodyKey)}`,
      signed: /\{\{\s*(signature|your_?name|sender_?name|my_?name)\b/i.test(v.body ?? ""),
    };
  });
  return { mails, map };
}

export function checkContact(ctx: any, contact: any, mailbox: any) {
  const { mails, map } = renderContact(ctx, contact, mailbox);
  const problems: string[] = [];
  const warnings: string[] = [];
  const cf = contact.custom_fields ?? {};
  if (!mailbox) problems.push("the campaign has no sending inbox attached");
  for (const t of [...ctx.tokens.standard, ...ctx.tokens.custom]) {
    if (!t.hasFallback && !String(map[t.key] ?? "").trim()) problems.push(`{{${t.token}}} is empty`);
  }
  for (const m of mails) {
    const tag = `email ${m.n}${m.variant && m.variant !== "A" ? ` (${m.variant})` : ""}`;
    const left = m.unresolved.match(/\{\{[^}]+\}\}/g);
    if (left) problems.push(`${tag}: ${[...new Set(left)].join(" ")} has no value`);
    if (!m.body) problems.push(`${tag}: empty body`);
    if (m.n === 1 && !m.subject) problems.push(`${tag}: empty subject`);
    if (/\(\(|\)\)|\[\[|\]\]|\{\{|\}\}|\bundefined\b|\bNaN\b|\bSIGNATURE\b/.test(`${m.subject}\n${m.body}`)) problems.push(`${tag}: leftover placeholder text`);
    if (!OPT_OUT.test(m.body)) problems.push(`${tag}: no opt-out line`);
    if (m.signed) {
      const sig = resolveSignature(mailbox?.signature, senderName(mailbox)).replace(/\r\n/g, "\n").trim();
      if (sig && !m.body.includes(sig)) problems.push(`${tag}: the inbox signature is missing`);
    } else warnings.push(`${tag}: the template has no {{signature}}`);
    if (/""|“”|\s,|[^\S\n]{2,}\S/.test(m.body.replace(/^[^\S\n]+/gm, ""))) warnings.push(`${tag}: spacing or punctuation looks off (a blank value?)`);
    if (m.n === 1 && m.subject.length > 70) warnings.push(`${tag}: subject is ${m.subject.length} characters`);
  }
  for (const k of ["firm", "competitor_1"]) {
    const v = String(cf[k] ?? "").trim();
    if (!v) continue;
    if (LEGAL_END.test(v)) problems.push(`${k} still has a legal ending: "${v}"`);
    if (/[A-Za-z]{6}/.test(v.replace(/[^A-Za-z]/g, "")) && v === v.toUpperCase()) problems.push(`${k} is ALL CAPS: "${v}"`);
    if (v.includes("|")) problems.push(`${k} carries a listing tagline: "${v}"`);
  }
  for (const k of ["ai_visibility", "domain_authority"]) {
    if (cf[k] != null && cf[k] !== "" && !(/^\d{1,3}$/.test(String(cf[k])) && Number(cf[k]) <= 100)) problems.push(`${k} is "${cf[k]}", not a 0-100 score`);
  }
  return { mails, problems, warnings };
}

/** Every contact against a rotating inbox (the pool spreads sends), plus each inbox's own signature once. */
export function checkContacts(ctx: any, contacts: any[]) {
  const results = contacts.map((c, i) => ({ contact: c, mailbox: ctx.pool[i % Math.max(1, ctx.pool.length)] ?? null }))
    .map(({ contact, mailbox }) => ({ contact, mailbox, ...checkContact(ctx, contact, mailbox) }));
  const inboxProblems: string[] = [];
  if (!ctx.pool.length) inboxProblems.push("no sending inboxes attached to the campaign");
  for (const mb of ctx.pool) {
    if (mb.status !== "active") inboxProblems.push(`${mb.email_address} is ${mb.status}`);
    if (contacts[0]) {
      const r = checkContact(ctx, contacts[0], mb);
      for (const p of r.problems.filter((x) => /signature/.test(x))) inboxProblems.push(`${mb.email_address}: ${p}`);
    }
  }
  return { results, inboxProblems };
}
