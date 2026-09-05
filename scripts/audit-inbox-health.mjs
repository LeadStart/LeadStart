/**
 * Read-only audit: why does every mailbox's inbox-health score sit at 100?
 *
 * Answers, from live data:
 *   1. What each native_mailbox's stored score/band/components actually are,
 *      in particular which components are "unchecked" (zero-penalty) vs "ok".
 *   2. Send volume: native_sends counts by status, all-time and last 7 days
 *      per mailbox (bounce component only scores at >= 20 sends/7d).
 *   3. Whether ANY bounce has ever been recorded (native_sends.status='bounced',
 *      contacts.status='bounced').
 *   4. Whether the poller is alive at all (lead_replies from native_email,
 *      last_polled_at per mailbox): replies flowing proves polling works,
 *      which narrows "no bounces" to either genuinely-clean lists or a
 *      detection gap.
 *   5. Org settings that gate signals: spamhaus_dqs_key presence (boolean
 *      only: the key itself is never printed) + offline threshold.
 *   6. mailbox_health_checks snapshot count per mailbox (score transitions
 *      ever observed: 1 row per mailbox forever = score never moved).
 *
 * Read-only. Safe to re-run any time.
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
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

async function rest(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "count=exact" },
  });
  const count = res.headers.get("content-range")?.split("/")[1] ?? null;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`REST ${res.status} on ${path.split("?")[0]}:`, JSON.stringify(body));
  }
  return { status: res.status, body: Array.isArray(body) ? body : null, count: count === null ? null : Number(count) };
}

const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

// ── 1. Org settings that gate health signals ────────────────────────────
const orgs = await rest(
  "organizations?select=id,name,spamhaus_dqs_key,inbox_health_offline_threshold",
);
console.log("=== Organizations (signal gates) ===");
for (const o of orgs.body || []) {
  console.log(
    `  ${o.name} (${o.id})\n` +
      `    spamhaus_dqs_key set: ${o.spamhaus_dqs_key ? "YES" : "NO"}\n` +
      `    offline threshold:    ${o.inbox_health_offline_threshold ?? "not set (auto-pause disabled)"}`,
  );
}

// ── 2. Mailboxes: stored score + component breakdown ────────────────────
const mbs = await rest(
  "native_mailboxes?select=id,email_address,status,health_score,health_band,health_checked_at,last_polled_at,created_at&order=email_address",
);
console.log(`\n=== native_mailboxes (${(mbs.body || []).length}) ===`);
const mbFull = await rest("native_mailboxes?select=id,email_address,health_components");
const compsById = new Map((mbFull.body || []).map((m) => [m.id, m.health_components]));

for (const m of mbs.body || []) {
  console.log(
    `\n  ${m.email_address}  [${m.status}]  score=${m.health_score ?? "never scored"} band=${m.health_band ?? "-"}` +
      `\n    created=${m.created_at?.slice(0, 10)}` +
      `\n    health_checked_at=${m.health_checked_at ?? "-"}  last_polled_at=${m.last_polled_at ?? "NEVER POLLED"}`,
  );
  const comps = compsById.get(m.id);
  if (Array.isArray(comps)) {
    for (const c of comps) {
      console.log(`      ${String(c.status).padEnd(9)} -${String(c.deduction).padEnd(3)} ${c.key}: ${c.detail}`);
    }
  }
}

// ── 3. native_sends: volume + status mix ────────────────────────────────
console.log("\n=== native_sends status mix (all time) ===");
const statuses = ["sent", "bounced", "failed", "skipped"];
for (const s of statuses) {
  const r = await rest(`native_sends?status=eq.${s}&select=id&limit=1`);
  console.log(`  ${s.padEnd(8)} ${r.count ?? "?"}`);
}
const allSends = await rest("native_sends?select=id&limit=1");
console.log(`  TOTAL    ${allSends.count ?? "?"}`);

const oldest = await rest("native_sends?select=sent_at&order=sent_at.asc&limit=1");
const newest = await rest("native_sends?select=sent_at&order=sent_at.desc&limit=1");
console.log(
  `  window: ${oldest.body?.[0]?.sent_at ?? "-"} → ${newest.body?.[0]?.sent_at ?? "-"}`,
);

console.log("\n=== native_sends last 7d per mailbox (bounce component needs >= 20) ===");
const recent = await rest(
  `native_sends?sent_at=gte.${sevenDaysAgo}&select=mailbox_id,status&limit=10000`,
);
const byMb = new Map();
for (const r of recent.body || []) {
  const cur = byMb.get(r.mailbox_id) ?? { sent: 0, bounced: 0 };
  cur.sent += 1;
  if (r.status === "bounced") cur.bounced += 1;
  byMb.set(r.mailbox_id, cur);
}
const emailById = new Map((mbs.body || []).map((m) => [m.id, m.email_address]));
if (byMb.size === 0) console.log("  (no sends in the last 7 days)");
for (const [id, st] of byMb) {
  console.log(`  ${(emailById.get(id) ?? id).padEnd(40)} sent7d=${st.sent} bounced7d=${st.bounced}`);
}

// ── 4. Any bounce ever, anywhere ────────────────────────────────────────
const bouncedContacts = await rest("contacts?status=eq.bounced&select=id&limit=1");
console.log(`\n=== bounce evidence ===`);
console.log(`  contacts with status='bounced':      ${bouncedContacts.count ?? "?"}`);
const bouncedSends = await rest("native_sends?status=eq.bounced&select=id,to_email,bounced_at,bounce_reason&limit=10");
console.log(`  native_sends with status='bounced':  ${bouncedSends.count ?? "?"}`);
for (const b of bouncedSends.body || []) {
  console.log(`    ${b.bounced_at}  ${b.to_email}  ${b.bounce_reason ?? ""}`);
}

// ── 5. Poller liveness: replies ingested from native email ──────────────
const replies = await rest("lead_replies?source_channel=eq.native_email&select=id&limit=1");
const latestReply = await rest(
  "lead_replies?source_channel=eq.native_email&select=received_at&order=received_at.desc&limit=1",
);
console.log(`\n=== poller liveness ===`);
console.log(`  lead_replies (native_email): ${replies.count ?? "?"}`);
console.log(`  most recent reply:           ${latestReply.body?.[0]?.received_at ?? "-"}`);

// ── 6. Health-check snapshots (score transitions ever) ──────────────────
console.log(`\n=== mailbox_health_checks snapshots per mailbox ===`);
for (const m of mbs.body || []) {
  const snaps = await rest(
    `mailbox_health_checks?mailbox_id=eq.${m.id}&select=score,band,checked_at&order=checked_at.asc&limit=100`,
  );
  const rows = snaps.body || [];
  const scores = rows.map((r) => `${r.checked_at?.slice(0, 10)}:${r.score}`).join("  ");
  console.log(`  ${m.email_address}: ${snaps.count ?? rows.length} snapshot(s)  ${scores}`);
}

// ── 7. Projected NEW scores under the 2026-08-19 scoring changes ─────────
// DMARC p=none → warn (-5); reply signal: 0 replies at >= 40 sends/14d → warn
// (-10). Hard/soft bounce stay ~0 at current rates. This projects what the next
// check-inbox-health run will write, so the score move is expected, not a bug.
console.log(`\n=== Projected new scores (after DMARC p=none→warn + reply signal) ===`);
const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();
const sends14 = await rest(
  `native_sends?sent_at=gte.${fourteenDaysAgo}&select=mailbox_id&limit=20000`,
);
const sent14ById = new Map();
for (const s of sends14.body || []) sent14ById.set(s.mailbox_id, (sent14ById.get(s.mailbox_id) ?? 0) + 1);
const replies14 = await rest(
  `lead_replies?source_channel=eq.native_email&received_at=gte.${fourteenDaysAgo}&select=native_mailbox_id&limit=5000`,
);
const replied14ById = new Map();
for (const r of replies14.body || []) {
  if (r.native_mailbox_id) replied14ById.set(r.native_mailbox_id, (replied14ById.get(r.native_mailbox_id) ?? 0) + 1);
}
for (const m of mbs.body || []) {
  const comps = compsById.get(m.id) || [];
  const dmarc = Array.isArray(comps) ? comps.find((c) => c.key === "dmarc") : null;
  const dmarcNone = dmarc && /p=none/i.test(dmarc.detail || "");
  const sent14 = sent14ById.get(m.id) ?? 0;
  const replied14 = replied14ById.get(m.id) ?? 0;
  const dmarcPenalty = dmarcNone ? 5 : 0;
  const replyPenalty = sent14 >= 40 && replied14 === 0 ? 10 : 0;
  const projected = 100 - dmarcPenalty - replyPenalty;
  const replyNote = sent14 < 40 ? "reply unchecked (<40 sends)" : `${replied14} replies/14d`;
  console.log(
    `  ${m.email_address.padEnd(40)} ${m.health_score} → ${projected}` +
      `  [dmarc ${dmarcNone ? "-5 (p=none)" : "ok"}, ${replyNote}${replyPenalty ? " → -10" : ""}]`,
  );
}

console.log("\nDone (read-only, nothing written).");
