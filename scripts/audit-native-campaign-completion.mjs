/**
 * Read-only audit: do finished native campaigns keep their inboxes locked?
 *
 * Background: the dedicated-inbox policy (src/lib/campaigns/mailbox-usage.ts)
 * lets an inbox belong to only one non-completed campaign. No code path moves a
 * native campaign to 'completed', so a campaign whose every enrollment has
 * finished keeps "owning" its inboxes.
 *
 * Answers, from live data:
 *   1. Live catalog (Management API, SELECT only): triggers on campaigns,
 *      campaign_enrollments and campaign_mailboxes; any function that updates
 *      campaigns or mentions 'completed' next to campaigns; pg_cron jobs that
 *      touch campaigns; CHECK constraints on campaigns.status; deployed Edge
 *      Functions. Covers the known drift between supabase/migrations and the
 *      live DB. Prints names and booleans only, never function or cron bodies
 *      (a cron command can embed a secret).
 *   2. Campaign status distribution by channel.
 *   3. Every native_email campaign that is not completed: enrollment counts by
 *      status, contacts assigned, last enrollment added, last send, its inbox
 *      pool, and a verdict: FINISHED (enrollments exist, none active or
 *      paused), NEVER LOADED (no enrollments), or IN PROGRESS.
 *   4. Inbox ownership the way mailboxUsageMap computes it, any inbox claimed
 *      by two non-completed campaigns at once, and the inboxes left free.
 *
 * Read-only: REST calls are GET/HEAD only and the catalog SQL must be a single
 * SELECT (the script refuses anything else). Secrets come from .env.local and
 * are never printed. Safe to re-run any time, e.g. after a fix, to confirm the
 * finished campaigns no longer hold inboxes.
 *
 *   node scripts/audit-native-campaign-completion.mjs
 */
import { readFileSync } from "node:fs";

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}

const env = loadEnvLocal();
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const MGMT_TOKEN = env.SUPABASE_ACCESS_TOKEN;
if (!SUPA_URL || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const REF = new URL(SUPA_URL).hostname.split(".")[0];

// ---- REST (GET/HEAD only) ----

async function get(path) {
  const out = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}${sep}limit=1000&offset=${offset}`, {
      method: "GET",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) throw new Error(`GET ${path.split("?")[0]} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function first(path) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}&limit=1`, {
    method: "GET",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rows = await res.json();
  return rows[0] ?? null;
}

async function count(path) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: "HEAD",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "count=exact" },
  });
  if (!res.ok) throw new Error(`HEAD ${path.split("?")[0]} -> ${res.status}`);
  const range = res.headers.get("content-range") ?? "";
  const n = Number(range.split("/")[1]);
  if (!Number.isFinite(n)) throw new Error(`no count for ${path.split("?")[0]} (content-range "${range}")`);
  return n;
}

// ---- Live catalog (Management API, single SELECT only) ----

async function sql(query) {
  if (!/^\s*(select|with)\b/i.test(query) || query.includes(";")) {
    throw new Error("refusing catalog query: only a single SELECT is allowed");
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MGMT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`catalog query -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const TRIGGERS = String.raw`
select c.relname as table_name, t.tgname as trigger_name, p.proname as function_name,
       t.tgenabled as enabled,
       p.prosrc ~* 'update\s+(public\.)?campaigns\M' as fn_updates_campaigns,
       p.prosrc ilike '%completed%' as fn_mentions_completed
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where not t.tgisinternal and n.nspname = 'public'
  and c.relname in ('campaigns', 'campaign_enrollments', 'campaign_mailboxes')
order by 1, 2`;

const FUNCTIONS = String.raw`
select n.nspname as schema, p.proname as function_name,
       p.prosrc ~* 'update\s+(public\.)?campaigns\M' as updates_campaigns,
       p.prosrc ilike '%completed%' as mentions_completed
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog', 'information_schema')
  and (p.prosrc ~* 'update\s+(public\.)?campaigns\M'
       or (p.prosrc ~* '\mcampaigns\M' and p.prosrc ilike '%completed%'))
order by 1, 2`;

const HAS_CRON = `select exists (select 1 from pg_extension where extname = 'pg_cron') as has_pg_cron`;

const CRON_JOBS = String.raw`
select jobid, jobname, schedule, active,
       command ~* '\mcampaigns\M' as touches_campaigns,
       command ilike '%completed%' as mentions_completed
from cron.job
order by jobid`;

const STATUS_COLUMN = `
select data_type, column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'campaigns' and column_name = 'status'`;

const STATUS_CHECKS = `
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.campaigns'::regclass and contype = 'c'
  and pg_get_constraintdef(oid) ilike '%status%'`;

async function auditCatalog() {
  console.log("== 1. Live catalog (does anything in the DB complete a campaign?)");
  if (!MGMT_TOKEN) {
    console.log("   SKIPPED: SUPABASE_ACCESS_TOKEN not set in .env.local");
    return;
  }
  const triggers = await sql(TRIGGERS);
  console.log(`   triggers on campaigns / campaign_enrollments / campaign_mailboxes: ${triggers.length}`);
  for (const t of triggers) {
    console.log(
      `     ${t.table_name}.${t.trigger_name} -> ${t.function_name}()  enabled=${t.enabled}` +
        `  updates_campaigns=${t.fn_updates_campaigns}  mentions_completed=${t.fn_mentions_completed}`,
    );
  }
  const fns = await sql(FUNCTIONS);
  console.log(`   functions that UPDATE campaigns, or mention campaigns + 'completed': ${fns.length}`);
  for (const f of fns) {
    console.log(`     ${f.schema}.${f.function_name}  updates_campaigns=${f.updates_campaigns}  mentions_completed=${f.mentions_completed}`);
  }
  const [{ has_pg_cron }] = await sql(HAS_CRON);
  if (has_pg_cron) {
    const jobs = await sql(CRON_JOBS);
    const hits = jobs.filter((j) => j.touches_campaigns);
    console.log(`   pg_cron jobs: ${jobs.length} total, ${hits.length} touch campaigns`);
    for (const j of hits) {
      console.log(`     #${j.jobid} ${j.jobname ?? "(unnamed)"} [${j.schedule}] active=${j.active} mentions_completed=${j.mentions_completed}`);
    }
  } else {
    console.log("   pg_cron: extension not installed");
  }
  const [col] = await sql(STATUS_COLUMN);
  console.log(`   campaigns.status column: ${col?.data_type} default=${col?.column_default} nullable=${col?.is_nullable}`);
  const checks = await sql(STATUS_CHECKS);
  console.log(`   CHECK constraints mentioning status on campaigns: ${checks.length}`);
  for (const c of checks) console.log(`     ${c.conname}: ${c.definition}`);

  const fnRes = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions`, {
    method: "GET",
    headers: { Authorization: `Bearer ${MGMT_TOKEN}` },
  });
  if (fnRes.ok) {
    const edge = await fnRes.json();
    console.log(`   deployed Edge Functions: ${edge.length}${edge.length ? "  " + edge.map((e) => e.slug).join(", ") : ""}`);
  } else {
    console.log(`   deployed Edge Functions: could not list (${fnRes.status})`);
  }
}

// ---- Data ----

const ENROLLMENT_STATUSES = ["active", "paused", "completed", "replied", "failed"];
const day = (iso) => (iso ? iso.slice(0, 10) : "never");

async function auditCampaigns() {
  const campaigns = await get(
    "campaigns?select=id,name,status,source_channel,mailbox_tag,organization_id,client_id,created_at,updated_at&order=created_at.asc",
  );

  console.log("\n== 2. Campaign status distribution (all channels)");
  const dist = new Map();
  for (const c of campaigns) {
    const k = `${c.source_channel ?? "(none)"} / ${c.status ?? "(null)"}`;
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...dist].sort()) console.log(`   ${k.padEnd(32)} ${n}`);

  const clientIds = [...new Set(campaigns.map((c) => c.client_id).filter(Boolean))];
  const clients = clientIds.length ? await get(`clients?select=id,name&id=in.(${clientIds.join(",")})`) : [];
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  // Exactly what mailboxUsageMap sees: status <> 'completed' (NULL excluded).
  const owning = campaigns.filter((c) => c.status !== null && c.status !== "completed");
  const poolRows = owning.length
    ? await get(`campaign_mailboxes?select=campaign_id,mailbox_id&campaign_id=in.(${owning.map((c) => c.id).join(",")})`)
    : [];
  const poolByCampaign = new Map();
  for (const r of poolRows) {
    if (!poolByCampaign.has(r.campaign_id)) poolByCampaign.set(r.campaign_id, []);
    poolByCampaign.get(r.campaign_id).push(r.mailbox_id);
  }

  const orgIds = [...new Set(campaigns.map((c) => c.organization_id))];
  const mailboxes = orgIds.length
    ? await get(`native_mailboxes?select=id,email_address,status,tags,organization_id&organization_id=in.(${orgIds.join(",")})&order=email_address.asc`)
    : [];
  const mailboxById = new Map(mailboxes.map((m) => [m.id, m]));

  console.log("\n== 3. Native campaigns that still own inboxes (status is not 'completed')");
  const native = owning.filter((c) => c.source_channel === "native_email");
  const verdicts = new Map();
  for (const c of native) {
    const counts = {};
    for (const s of ENROLLMENT_STATUSES) {
      counts[s] = await count(`campaign_enrollments?select=id&campaign_id=eq.${c.id}&status=eq.${s}`);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const unfinished = counts.active + counts.paused;
    const verdict = total === 0 ? "NEVER LOADED" : unfinished === 0 ? "FINISHED" : "IN PROGRESS";
    verdicts.set(c.id, verdict);

    const assigned = await count(`contacts?select=id&campaign_id=eq.${c.id}`);
    const steps = await count(`campaign_steps?select=id&campaign_id=eq.${c.id}`);
    const sends = await count(`native_sends?select=id&campaign_id=eq.${c.id}`);
    const lastEnroll = await first(`campaign_enrollments?select=created_at&campaign_id=eq.${c.id}&order=created_at.desc`);
    const lastSend = await first(`native_sends?select=sent_at&campaign_id=eq.${c.id}&sent_at=not.is.null&order=sent_at.desc`);
    const pool = (poolByCampaign.get(c.id) ?? []).map((id) => mailboxById.get(id)?.email_address ?? `(unknown ${id})`);

    console.log(`\n   [${verdict}] "${c.name}"  status=${c.status}  client=${clientName.get(c.client_id) ?? "(none)"}`);
    console.log(`     id ${c.id}  created ${day(c.created_at)}  updated ${day(c.updated_at)}  steps ${steps}  tag ${c.mailbox_tag ?? "(none)"}`);
    console.log(
      `     enrollments ${total}: ` + ENROLLMENT_STATUSES.map((s) => `${s} ${counts[s]}`).join(", ") +
        `  |  contacts assigned ${assigned}`,
    );
    console.log(`     last enrollment added ${day(lastEnroll?.created_at)}  |  sends ${sends}, last send ${day(lastSend?.sent_at)}`);
    console.log(`     holds ${pool.length} inbox(es): ${pool.length ? pool.join(", ") : "(none)"}`);
  }

  console.log("\n== 3b. Native campaigns already completed (they free their inboxes)");
  const done = campaigns.filter((c) => c.source_channel === "native_email" && c.status === "completed");
  if (done.length === 0) console.log("   (none)");
  for (const c of done) {
    const counts = {};
    for (const s of ENROLLMENT_STATUSES) {
      counts[s] = await count(`campaign_enrollments?select=id&campaign_id=eq.${c.id}&status=eq.${s}`);
    }
    const sends = await count(`native_sends?select=id&campaign_id=eq.${c.id}`);
    const lastSend = await first(`native_sends?select=sent_at&campaign_id=eq.${c.id}&sent_at=not.is.null&order=sent_at.desc`);
    const pool = await get(`campaign_mailboxes?select=mailbox_id&campaign_id=eq.${c.id}`);
    const poolEmails = pool.map((r) => mailboxById.get(r.mailbox_id)?.email_address ?? `(unknown ${r.mailbox_id})`);
    console.log(`\n   "${c.name}"  client=${clientName.get(c.client_id) ?? "(none)"}`);
    console.log(`     id ${c.id}  created ${day(c.created_at)}  updated ${c.updated_at ?? "never"} (last row change)`);
    console.log(`     enrollments: ` + ENROLLMENT_STATUSES.map((s) => `${s} ${counts[s]}`).join(", ") + `  |  sends ${sends}, last send ${day(lastSend?.sent_at)}`);
    console.log(`     pool rows still on file: ${poolEmails.length ? poolEmails.join(", ") : "(none)"}`);
  }

  const nonNativeHolding = owning.filter((c) => c.source_channel !== "native_email" && (poolByCampaign.get(c.id) ?? []).length > 0);
  if (nonNativeHolding.length) {
    console.log("\n   Non-native campaigns that also hold inboxes:");
    for (const c of nonNativeHolding) {
      console.log(`     "${c.name}" (${c.source_channel}, ${c.status}) holds ${(poolByCampaign.get(c.id) ?? []).length}`);
    }
  }

  console.log("\n== 4. Inbox ownership (what the dedicated-inbox policy enforces)");
  const owners = new Map();
  for (const r of poolRows) {
    if (!owners.has(r.mailbox_id)) owners.set(r.mailbox_id, []);
    owners.get(r.mailbox_id).push(r.campaign_id);
  }
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const lockedByFinished = [];
  const shared = [];
  for (const [mailboxId, campIds] of owners) {
    if (campIds.length > 1) shared.push([mailboxId, campIds]);
    if (campIds.every((id) => verdicts.get(id) === "FINISHED")) lockedByFinished.push([mailboxId, campIds]);
  }
  console.log(`   inboxes claimed by a non-completed campaign: ${owners.size}`);
  console.log(`   ...held ONLY by FINISHED campaigns (locked, nothing left to send): ${lockedByFinished.length}`);
  for (const [mailboxId, campIds] of lockedByFinished) {
    const m = mailboxById.get(mailboxId);
    console.log(`     ${m?.email_address ?? mailboxId} [${m?.status ?? "?"}] <- ${campIds.map((id) => `"${byId.get(id)?.name}"`).join(", ")}`);
  }
  console.log(`   ...claimed by 2+ non-completed campaigns at once (policy breach): ${shared.length}`);
  for (const [mailboxId, campIds] of shared) {
    const m = mailboxById.get(mailboxId);
    console.log(`     ${m?.email_address ?? mailboxId} <- ${campIds.map((id) => `"${byId.get(id)?.name}" (${byId.get(id)?.status})`).join(", ")}`);
  }
  const free = mailboxes.filter((m) => !owners.has(m.id));
  console.log(`   inboxes free for a new campaign: ${free.length} of ${mailboxes.length} (any inbox status)`);
  for (const m of free) console.log(`     ${m.email_address} [${m.status}]${m.tags?.length ? "  tags: " + m.tags.join(", ") : ""}`);
}

await auditCatalog();
await auditCampaigns();
console.log("\nDone. Read-only: nothing was written.");
