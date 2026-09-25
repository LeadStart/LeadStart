#!/usr/bin/env node
/**
 * One-off, idempotent re-scan of every sending mailbox's bounce notices with
 * the CURRENT parser (classifyBounce + findBouncedSend), to correct the history
 * the old parser got wrong. Verified 2026-09-25 against the real mailboxes:
 *   - final Gmail "(Failure)" notices quoting a 4.x.x code were filed as SOFT,
 *     so an unreachable address was mailed for its whole sequence;
 *   - Microsoft 365 / Mimecast reports on a thread of their own were DROPPED;
 *   - pre-2026-08-19 recipient-matched bounces suppressed the contact but never
 *     marked the send, so they never reached the bounce rate;
 *   - no bounce recorded its code or class, so a receiver refusing our mail as
 *     spam looked exactly like a dead address.
 *
 * DRY RUN by default: prints every change it would make, writes nothing.
 *   npx tsx scripts/backfill-native-bounces.ts
 *   npx tsx scripts/backfill-native-bounces.ts --apply     (owner-approved only)
 *
 * --apply writes: native_sends status / bounced_at / bounce_reason, plus
 * bounce_code / bounce_class / bounce_diagnostic when migration 00131 is
 * applied (skipped with a note otherwise); soft_bounced_at for an unstamped
 * delay; contacts -> 'bounced' (never over 'replied' or 'unsubscribed'); active
 * enrollments -> 'failed'. Re-running after --apply changes nothing.
 * Reads Gmail with the org's service account (gmail.readonly). Prints no
 * recipient addresses, only their domains.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { GoogleServiceAccount } from "../src/lib/google/auth.ts";
import { parseGmailMessage, isBounce, classifyBounce, extractFailedRecipient, type BounceVerdict } from "../src/lib/gmail/mime.ts";
import { findBouncedSend, bounceReasonText, type BouncedSendRow } from "../src/lib/native/bounce-attribution.ts";
import type { GmailMessage } from "../src/lib/gmail/client.ts";

const APPLY = process.argv.includes("--apply");

const env: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
  if (m) env[m[1]] = m[3];
}
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const domainOf = (email: string | null | undefined) => (email?.includes("@") ? email.split("@")[1] : "?");
const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "????-??-??");

interface Notice {
  mailbox: string;
  dateMs: number | null;
  verdict: BounceVerdict;
  send: BouncedSendRow | null;
  via: string | null;
  recipient: string | null;
  subject: string;
}

async function main() {
// Migration 00131 present? (Selecting a missing column errors.)
const hasDetail = !(await admin.from("native_sends").select("bounce_class").limit(1)).error;

const { data: orgs, error: orgErr } = await admin
  .from("organizations")
  .select("id, name, gmail_service_account_email, gmail_service_account_key")
  .not("gmail_service_account_key", "is", null);
if (orgErr) throw new Error(orgErr.message);

const notices: Notice[] = [];
for (const org of orgs ?? []) {
  const sa = new GoogleServiceAccount(org.gmail_service_account_email, org.gmail_service_account_key);
  const gm = async (mailbox: string, path: string) => {
    const token = await sa.getAccessToken(mailbox, "https://www.googleapis.com/auth/gmail.readonly");
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`gmail ${res.status} for ${mailbox}`);
    return res.json();
  };

  const { data: mailboxes } = await admin
    .from("native_mailboxes")
    .select("id, email_address, status")
    .eq("organization_id", org.id)
    .neq("status", "error");
  for (const mb of mailboxes ?? []) {
    // Every send from this mailbox (paged past the 1,000-row cap).
    const sends: (BouncedSendRow & { gmail_thread_id: string | null })[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin
        .from("native_sends")
        .select("id, organization_id, campaign_id, contact_id, enrollment_id, to_email, status, step_index, sent_at, soft_bounced_at, gmail_thread_id")
        .eq("mailbox_id", mb.id)
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      sends.push(...((data ?? []) as typeof sends));
      if ((data ?? []).length < 1000) break;
    }
    if (sends.length === 0) continue;
    const firstSendMs = Math.min(...sends.map((s) => Date.parse(s.sent_at!)));
    const latestInThread = new Map<string, BouncedSendRow>();
    for (const s of sends) {
      if (!s.gmail_thread_id) continue;
      const cur = latestInThread.get(s.gmail_thread_id);
      if (!cur || s.sent_at! > cur.sent_at!) latestInThread.set(s.gmail_thread_id, s);
    }

    // Every inbox + spam message since the mailbox's first campaign send.
    const ids: { id: string; threadId: string }[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        q: `(in:inbox OR in:spam) after:${Math.floor(firstSendMs / 1000) - 86_400}`,
        maxResults: "500",
        includeSpamTrash: "true",
      });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await gm(mb.email_address, `/messages?${q}`);
      ids.push(...(page.messages ?? []));
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);

    for (const e of ids) {
      const meta = await gm(
        mb.email_address,
        `/messages/${e.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Content-Type&metadataHeaders=X-Failed-Recipients&metadataHeaders=X-MS-Exchange-Message-Is-Ndr`,
      );
      const hs: { name: string; value: string }[] = meta.payload?.headers ?? [];
      const hv = (n: string) => hs.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value;
      const looksLikeNotice =
        /mailer-daemon|postmaster/i.test(hv("From") ?? "") ||
        /multipart\/report/i.test(hv("Content-Type") ?? "") ||
        hv("X-Failed-Recipients") != null ||
        hv("X-MS-Exchange-Message-Is-Ndr") != null ||
        /^\s*(delivery status notification|undeliverable|undelivered mail|(your )?message( to \S+)? (couldn|could not|can|cannot|wasn|was not))/i.test(hv("Subject") ?? "");
      if (!looksLikeNotice) continue;

      const full = (await gm(mb.email_address, `/messages/${e.id}?format=full`)) as GmailMessage;
      const parsed = parseGmailMessage(full);
      if (!isBounce(parsed)) continue;
      if (parsed.internalDateMs && parsed.internalDateMs < firstSendMs) continue; // predates LeadStart sending
      const verdict = classifyBounce(parsed);
      if (verdict.severity === "none") continue;
      const { send, via } = await findBouncedSend(admin, mb.id, parsed, latestInThread.get(full.threadId) ?? null);
      notices.push({
        mailbox: mb.email_address,
        dateMs: parsed.internalDateMs,
        verdict,
        send,
        via,
        recipient: send?.to_email ?? extractFailedRecipient(parsed),
        subject: parsed.subject ?? "",
      });
    }
  }
}

// ── Plan ─────────────────────────────────────────────────────────────────────
notices.sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));
const hardBySend = new Map<string, Notice>(); // earliest hard notice per send
for (const n of notices) {
  if (n.verdict.severity === "hard" && n.send && !hardBySend.has(n.send.id)) hardBySend.set(n.send.id, n);
}
const detailById = new Map<string, string | null>();
if (hasDetail && hardBySend.size > 0) {
  const { data } = await admin.from("native_sends").select("id, bounce_class").in("id", [...hardBySend.keys()]);
  for (const r of (data ?? []) as { id: string; bounce_class: string | null }[]) detailById.set(r.id, r.bounce_class);
}
const contactIds = [...new Set([...hardBySend.values()].map((n) => n.send!.contact_id))];
const contactStatus = new Map<string, string>();
if (contactIds.length) {
  const { data } = await admin.from("contacts").select("id, status").in("id", contactIds);
  for (const c of (data ?? []) as { id: string; status: string }[]) contactStatus.set(c.id, c.status);
}
const enrollmentIds = [...new Set([...hardBySend.values()].map((n) => n.send!.enrollment_id).filter((x): x is string => !!x))];
const enrollmentStatus = new Map<string, string>();
if (enrollmentIds.length) {
  const { data } = await admin.from("campaign_enrollments").select("id, status").in("id", enrollmentIds);
  for (const r of (data ?? []) as { id: string; status: string }[]) enrollmentStatus.set(r.id, r.status);
}

type Action = { kind: string; run: () => Promise<void>; label: string };
const actions: Action[] = [];
const upd = async (table: string, patch: Record<string, unknown>, id: string, guard?: [string, string]) => {
  let q = admin.from(table).update(patch).eq("id", id);
  if (guard) q = q.eq(guard[0], guard[1]);
  const { error } = await q;
  if (error) throw new Error(`${table} ${id}: ${error.message}`);
};

console.log(`\nBounce notices found since each mailbox's first send: ${notices.length}  (migration 00131 ${hasDetail ? "applied" : "NOT applied: detail columns skipped"})\n`);
console.log("date        mailbox                                  sev   class               code      via         step  recipient-domain        planned change");
const doneContacts = new Set<string>();
const doneEnrollments = new Set<string>();
for (const n of notices) {
  const s = n.send;
  const base =
    `${day(n.dateMs)}  ${n.mailbox.padEnd(40)} ${n.verdict.severity.padEnd(5)} ${String(n.verdict.bounceClass ?? "-").padEnd(19)} ` +
    `${String(n.verdict.code ?? "-").padEnd(9)} ${String(n.via ?? "none").padEnd(11)} ${String(s?.step_index ?? "-").padEnd(5)} ${domainOf(n.recipient).padEnd(23)}`;
  const planned: string[] = [];
  if (n.verdict.severity === "hard" && s && hardBySend.get(s.id) === n) {
    const detail = hasDetail
      ? { bounce_code: n.verdict.code, bounce_class: n.verdict.bounceClass, bounce_diagnostic: n.verdict.diagnostic }
      : {};
    if (s.status !== "bounced") {
      planned.push(`MARK send bounced${s.soft_bounced_at ? " (was filed soft)" : ""}`);
      actions.push({
        kind: "mark",
        label: `send ${s.id}`,
        run: () =>
          upd("native_sends", {
            status: "bounced",
            bounced_at: new Date(n.dateMs ?? Date.now()).toISOString(),
            bounce_reason: bounceReasonText(n.verdict, n.subject),
            ...detail,
          }, s.id),
      });
    } else if (hasDetail && detailById.get(s.id) == null) {
      planned.push("ENRICH already-bounced send with code/class");
      actions.push({
        kind: "enrich",
        label: `send ${s.id}`,
        run: () => upd("native_sends", { bounce_reason: bounceReasonText(n.verdict, n.subject), ...detail }, s.id),
      });
    } else if (!hasDetail && s.status === "bounced") {
      planned.push("already bounced (class recorded once 00131 is applied)");
    }
    const cs = contactStatus.get(s.contact_id);
    if (!doneContacts.has(s.contact_id)) {
      doneContacts.add(s.contact_id);
      if (cs && !["bounced", "unsubscribed", "replied"].includes(cs)) {
        planned.push(`SUPPRESS contact (${cs} -> bounced)`);
        actions.push({ kind: "contact", label: `contact ${s.contact_id}`, run: () => upd("contacts", { status: "bounced" }, s.contact_id) });
      } else if (cs === "replied") {
        planned.push("contact left 'replied'");
      }
    }
    if (s.enrollment_id && !doneEnrollments.has(s.enrollment_id)) {
      doneEnrollments.add(s.enrollment_id);
      if (enrollmentStatus.get(s.enrollment_id) === "active") {
        planned.push("FAIL active enrollment");
        actions.push({
          kind: "enrollment",
          label: `enrollment ${s.enrollment_id}`,
          run: () => upd("campaign_enrollments", { status: "failed", last_error: "Hard bounce" }, s.enrollment_id!, ["status", "active"]),
        });
      }
    }
  } else if (n.verdict.severity === "hard" && s) {
    planned.push("(same send: earlier notice already counted)");
  } else if (n.verdict.severity === "soft" && s) {
    if (!hardBySend.has(s.id) && s.status !== "bounced" && !s.soft_bounced_at) {
      planned.push("STAMP soft bounce");
      actions.push({
        kind: "soft",
        label: `send ${s.id}`,
        run: () => upd("native_sends", { soft_bounced_at: new Date(n.dateMs ?? Date.now()).toISOString() }, s.id),
      });
    } else planned.push("-");
  } else {
    planned.push(n.recipient ? "no matching send (address not mailed from here)" : "UNATTRIBUTABLE");
  }
  console.log(`${base} ${planned.join("; ")}`);
}

const byKind = actions.reduce<Record<string, number>>((a, x) => ((a[x.kind] = (a[x.kind] ?? 0) + 1), a), {});
const { count: bouncedNow } = await admin.from("native_sends").select("id", { count: "exact", head: true }).eq("status", "bounced");
const { count: totalSends } = await admin.from("native_sends").select("id", { count: "exact", head: true });
const newMarks = byKind.mark ?? 0;
console.log(`\nPlanned: ${JSON.stringify(byKind)}`);
console.log(
  `Hard-bounced sends: ${bouncedNow} recorded now -> ${(bouncedNow ?? 0) + newMarks} after backfill ` +
    `(${(((bouncedNow ?? 0) / (totalSends ?? 1)) * 100).toFixed(2)}% -> ${((((bouncedNow ?? 0) + newMarks) / (totalSends ?? 1)) * 100).toFixed(2)}% of ${totalSends} sends)`,
);
const cls = [...hardBySend.values()].reduce<Record<string, number>>((a, n) => {
  const k = n.verdict.bounceClass ?? "other";
  a[k] = (a[k] ?? 0) + 1;
  return a;
}, {});
console.log(`Hard bounces by class: ${JSON.stringify(cls)}`);

if (!APPLY) {
  console.log("\nDRY RUN: nothing written. Re-run with --apply to write the changes above.");
} else {
  let ok = 0;
  for (const a of actions) {
    try {
      await a.run();
      ok++;
    } catch (err) {
      console.error(`FAILED ${a.kind} ${a.label}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nAPPLIED ${ok}/${actions.length} changes.`);
}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
