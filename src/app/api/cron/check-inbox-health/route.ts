// GET /app/api/cron/check-inbox-health — runs hourly at :30 (vercel.json).
//
// Scores every native (Gmail) sending mailbox 0–100 from free signals — live
// SPF/DKIM/DMARC/MX DNS, the Spamhaus domain blocklist, and the 7-day
// hard-bounce rate from native_sends — then:
//   - writes the denormalized score onto native_mailboxes (always),
//   - inserts a mailbox_health_checks snapshot ONLY when the score changed or
//     an action was taken (keeps that table a transition timeline),
//   - auto-pauses a mailbox when its org has set an offline threshold AND the
//     mailbox scored below it on TWO consecutive checks (the guard against a
//     one-off DNS blip benching a healthy inbox),
//   - enqueues an owner alert on auto-pause, or on a fresh transition into the
//     "critical" band (band-transition-only, so a lingering-critical mailbox
//     doesn't re-alert every hour).
//
// Auto-pause is a plain status='paused' write; the send dispatcher already
// skips non-active mailboxes (eligible() in run-native-sequences), so there's
// no dispatcher change. See src/lib/deliverability/inbox-health.ts for the
// scoring model and the "unchecked signals are never penalized" stance.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { checkDomainAuth, checkMx, domainOf } from "@/lib/deliverability/check";
import type { AuthCheck, DomainAuth } from "@/lib/deliverability/check";
import { checkDbl } from "@/lib/deliverability/dnsbl";
import type { DblResult } from "@/lib/deliverability/dnsbl";
import { computeInboxHealth, summarizeIssues } from "@/lib/deliverability/inbox-health";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import type { NativeMailbox } from "@/types/app";

// See dispatch-owner-alerts/route.ts — force-dynamic so a Vercel cron never
// gets an edge-cached response instead of running the body.
export const dynamic = "force-dynamic";
// node:dns lookups need the Node runtime (matches the campaign deliverability route).
export const runtime = "nodejs";
export const maxDuration = 60;

interface OrgSettings {
  id: string;
  spamhaus_dqs_key: string | null;
  inbox_health_offline_threshold: number | null;
}

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // 1) All native mailboxes across every org, every status. Paused/error
  // mailboxes are still scored (informational; enforcement only touches
  // active ones).
  const { data: mailboxRows, error: mbError } = await admin
    .from("native_mailboxes")
    .select("*")
    .order("organization_id", { ascending: true });
  if (mbError) {
    return NextResponse.json({ error: mbError.message }, { status: 500 });
  }
  const mailboxes = (mailboxRows ?? []) as NativeMailbox[];
  if (mailboxes.length === 0) {
    return NextResponse.json({ status: "idle", mailboxes: 0 });
  }

  // 2) Per-org keys + threshold. Bail on a read error rather than proceeding
  // with an empty org map — otherwise every mailbox would be scored with no
  // key and no threshold, writing an inflated "healthy" score over its real
  // state and disabling enforcement. A failed run just retries next tick.
  const orgIds = Array.from(new Set(mailboxes.map((m) => m.organization_id)));
  const { data: orgRows, error: orgError } = await admin
    .from("organizations")
    .select("id, spamhaus_dqs_key, inbox_health_offline_threshold")
    .in("id", orgIds);
  if (orgError) {
    return NextResponse.json({ error: orgError.message }, { status: 500 });
  }
  const orgMap = new Map<string, OrgSettings>(
    ((orgRows ?? []) as OrgSettings[]).map((o) => [o.id, o]),
  );

  // 3) 7-day send/bounce counts per mailbox, one sweep of native_sends. Same
  // reasoning as above: a read error here would silently zero every mailbox's
  // bounce rate, so fail the run instead of scoring on bad data.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: sendRows, error: sendError } = await admin
    .from("native_sends")
    .select("mailbox_id, status, sent_at")
    .gte("sent_at", sevenDaysAgo);
  if (sendError) {
    return NextResponse.json({ error: sendError.message }, { status: 500 });
  }
  const statsByMailbox = new Map<string, { sent7d: number; bounced7d: number }>();
  for (const s of (sendRows ?? []) as { mailbox_id: string; status: string }[]) {
    const cur = statsByMailbox.get(s.mailbox_id) ?? { sent7d: 0, bounced7d: 0 };
    cur.sent7d += 1;
    if (s.status === "bounced") cur.bounced7d += 1;
    statsByMailbox.set(s.mailbox_id, cur);
  }

  // Per-run cache: DNS/DBL keyed by org+domain (a domain's listing/auth is the
  // same for every mailbox on it).
  const domainCache = new Map<string, { domainAuth: DomainAuth; mx: AuthCheck; dbl: DblResult }>();

  const tally = {
    mailboxes: mailboxes.length,
    scored: 0,
    snapshots: 0,
    auto_paused: 0,
    degraded_alerts: 0,
    errors: 0,
  };

  for (const mb of mailboxes) {
    try {
      const org = orgMap.get(mb.organization_id) ?? null;
      const domain = domainOf(mb.email_address);

      // DNS + MX + DBL (cached per org+domain).
      const cacheKey = `${org?.id ?? "none"}:${domain}`;
      let signals = domainCache.get(cacheKey);
      if (!signals) {
        const [domainAuth, mx, dbl] = await Promise.all([
          checkDomainAuth(domain),
          checkMx(domain),
          checkDbl(domain, org?.spamhaus_dqs_key),
        ]);
        signals = { domainAuth, mx, dbl };
        domainCache.set(cacheKey, signals);
      }

      const health = computeInboxHealth({
        dbl: signals.dbl,
        domainAuth: signals.domainAuth,
        mx: signals.mx,
        bounces: statsByMailbox.get(mb.id) ?? null,
      });

      const prevScore = mb.health_score;
      const prevBand = mb.health_band;
      const threshold = org?.inbox_health_offline_threshold ?? null;
      const nowIso = new Date().toISOString();

      const update: Record<string, unknown> = {
        health_score: health.score,
        health_band: health.band,
        health_components: health.components,
        health_checked_at: nowIso,
      };

      // Enforcement: two consecutive sub-threshold checks on an active mailbox.
      // prevScore == null (first check ever) can never trip it.
      let action: string | null = null;
      if (
        threshold != null &&
        mb.status === "active" &&
        health.score < threshold &&
        prevScore != null &&
        prevScore < threshold
      ) {
        update.status = "paused";
        update.health_paused_at = nowIso;
        action = "auto_paused";
      }

      const { error: updateError } = await admin
        .from("native_mailboxes")
        .update(update)
        .eq("id", mb.id);
      if (updateError) {
        throw new Error(`native_mailboxes update failed: ${updateError.message}`);
      }

      // Snapshot only on a score change or an action (transition timeline).
      if (health.score !== prevScore || action) {
        await admin.from("mailbox_health_checks").insert({
          organization_id: mb.organization_id,
          mailbox_id: mb.id,
          score: health.score,
          band: health.band,
          components: health.components,
          action,
        });
        tally.snapshots += 1;
      }

      const topIssues = summarizeIssues(health.components);

      if (action === "auto_paused") {
        tally.auto_paused += 1;
        await enqueueOwnerAlert({
          admin,
          kind: "inbox_health_auto_paused",
          subject: `Mailbox ${mb.email_address} was taken offline (health ${health.score})`,
          summary:
            `${mb.email_address} scored ${health.score} on two checks in a row, below the ${threshold} offline threshold, ` +
            `so it was paused automatically and has stopped sending. ` +
            (topIssues ? `${topIssues} ` : "") +
            `Resume it from Admin → Mailboxes once it recovers.`,
          context: {
            mailbox: mb.email_address,
            score: health.score,
            band: health.band,
            threshold,
          },
        });
      } else if (health.band === "critical" && prevBand !== "critical") {
        tally.degraded_alerts += 1;
        await enqueueOwnerAlert({
          admin,
          kind: "inbox_health_degraded",
          subject: `Mailbox ${mb.email_address} health is critical (score ${health.score})`,
          summary:
            `${mb.email_address} dropped to a critical health score of ${health.score}. ` +
            (topIssues || "See Admin → Mailboxes for the breakdown."),
          context: {
            mailbox: mb.email_address,
            score: health.score,
            previous_band: prevBand ?? "unscored",
          },
        });
      }

      tally.scored += 1;
    } catch (err) {
      tally.errors += 1;
      console.error(
        `[cron/check-inbox-health] failed for ${mb.email_address}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.json(tally);
}
