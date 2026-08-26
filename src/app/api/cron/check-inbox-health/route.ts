// GET /app/api/cron/check-inbox-health — runs hourly at :30 (vercel.json).
//
// Scores every native (Gmail) sending mailbox 0–100 from free signals — live
// SPF/DKIM/DMARC/MX DNS, the Spamhaus domain blocklist, the 7-day hard/soft
// bounce rates from native_sends, the 14-day reply signal, and the latest
// seed placement test (migration 00068; the one direct measurement) — then:
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
import {
  latestCompletePlacementTests,
  placementSignalFromTest,
} from "@/lib/deliverability/placement-runner";
import { PLACEMENT_FRESHNESS_DAYS } from "@/lib/deliverability/placement";
import { nextWatchStreak } from "@/lib/deliverability/lifecycle";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import type { HealthBand, HealthComponent, NativeMailbox } from "@/types/app";

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

  // 2b) Prior domain rollup state (migration 00081) — the watch_streak and last
  // check date, for the daily watch-streak accounting below. Keyed by domain_id.
  // A read error here is non-fatal: domains just start their streak fresh (the
  // rollup is advisory and nothing enforces on it yet).
  const domainIds = Array.from(
    new Set(mailboxes.map((m) => m.domain_id).filter((id): id is string => !!id)),
  );
  const priorDomain = new Map<string, { watch_streak: number; health_checked_at: string | null }>();
  if (domainIds.length > 0) {
    const { data: domRows, error: domErr } = await admin
      .from("sending_domains")
      .select("id, watch_streak, health_checked_at")
      .in("id", domainIds);
    if (domErr) {
      console.error("[cron/check-inbox-health] prior domain-rollup read failed:", domErr.message);
    } else {
      for (const d of (domRows ?? []) as {
        id: string;
        watch_streak: number | null;
        health_checked_at: string | null;
      }[]) {
        priorDomain.set(d.id, { watch_streak: d.watch_streak ?? 0, health_checked_at: d.health_checked_at });
      }
    }
  }

  // 3) Send stats per mailbox from ONE 14-day sweep of native_sends: the 7-day
  // hard+soft bounce counts (bounce components) and the 14-day send volume (the
  // reply signal's denominator). Same reasoning as above: a read error here
  // would silently zero every mailbox, so fail the run rather than score on bad
  // data.
  const now = Date.now();
  const sevenDaysAgoMs = now - 7 * 86_400_000;
  const fourteenDaysAgo = new Date(now - 14 * 86_400_000).toISOString();
  const { data: sendRows, error: sendError } = await admin
    .from("native_sends")
    .select("mailbox_id, status, sent_at, soft_bounced_at")
    .gte("sent_at", fourteenDaysAgo);
  if (sendError) {
    return NextResponse.json({ error: sendError.message }, { status: 500 });
  }
  interface SendStats {
    sent7d: number;
    bounced7d: number;
    softBounced7d: number;
    sent14d: number;
  }
  const statsByMailbox = new Map<string, SendStats>();
  for (const s of (sendRows ?? []) as {
    mailbox_id: string;
    status: string;
    sent_at: string;
    soft_bounced_at: string | null;
  }[]) {
    const cur =
      statsByMailbox.get(s.mailbox_id) ??
      { sent7d: 0, bounced7d: 0, softBounced7d: 0, sent14d: 0 };
    cur.sent14d += 1;
    if (Date.parse(s.sent_at) >= sevenDaysAgoMs) {
      cur.sent7d += 1;
      if (s.status === "bounced") cur.bounced7d += 1;
      if (s.soft_bounced_at) cur.softBounced7d += 1;
    }
    statsByMailbox.set(s.mailbox_id, cur);
  }

  // 3b) 14-day native-email reply counts per mailbox, for the reply signal.
  // Unlike the sweeps above, a read error here does NOT fail the run: the reply
  // signal is advisory, and — critically — on error we must treat it as
  // "unchecked", never "zero replies" (which would fire a false placement
  // warning). replyReadOk gates that: false → pass replies:null (unchecked).
  const repliesByMailbox = new Map<string, number>();
  let replyReadOk = true;
  const { data: replyRows, error: replyError } = await admin
    .from("lead_replies")
    .select("native_mailbox_id")
    .eq("source_channel", "native_email")
    .gte("received_at", fourteenDaysAgo);
  if (replyError) {
    replyReadOk = false;
    console.error("[cron/check-inbox-health] reply count read failed:", replyError.message);
  } else {
    for (const r of (replyRows ?? []) as { native_mailbox_id: string | null }[]) {
      if (!r.native_mailbox_id) continue;
      repliesByMailbox.set(
        r.native_mailbox_id,
        (repliesByMailbox.get(r.native_mailbox_id) ?? 0) + 1,
      );
    }
  }

  // 3c) Latest COMPLETE seed placement test per mailbox, no older than
  // PLACEMENT_FRESHNESS_DAYS, for the seed_placement component. Advisory like
  // the reply signal: a read error (or simply no recent test) → unchecked.
  const placementSince = new Date(now - PLACEMENT_FRESHNESS_DAYS * 86_400_000).toISOString();
  const placementRead = await latestCompletePlacementTests(admin, placementSince);

  // Per-run cache: DNS/DBL keyed by org+domain (a domain's listing/auth is the
  // same for every mailbox on it).
  const domainCache = new Map<string, { domainAuth: DomainAuth; mx: AuthCheck; dbl: DblResult }>();

  // Per-domain health rollup accumulator (migration 00081). A domain shares its
  // reputation across every inbox on it, so its health is that of its WORST
  // (lowest-scoring) member mailbox — the weakest inbox is the burn risk. The
  // worst mailbox's components come along so the domain card's score and its
  // "why" always agree. Keyed by domain_id; written after the loop. Choice of
  // "worst inbox" is deliberately conservative and Phase-5-tunable (nothing
  // enforces on this rollup yet).
  const domainRollup = new Map<string, { score: number; band: HealthBand; components: HealthComponent[] }>();

  const tally = {
    mailboxes: mailboxes.length,
    scored: 0,
    snapshots: 0,
    auto_paused: 0,
    degraded_alerts: 0,
    domains_rolled: 0,
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

      const stats = statsByMailbox.get(mb.id) ?? null;
      const health = computeInboxHealth({
        dbl: signals.dbl,
        domainAuth: signals.domainAuth,
        mx: signals.mx,
        bounces: stats
          ? { sent7d: stats.sent7d, bounced7d: stats.bounced7d, softBounced7d: stats.softBounced7d }
          : null,
        // replyReadOk === false → unchecked (never a false "zero replies").
        replies:
          replyReadOk && stats
            ? { sent14d: stats.sent14d, replied14d: repliesByMailbox.get(mb.id) ?? 0 }
            : null,
        placement: (() => {
          const pt = placementRead.byMailbox.get(mb.id);
          return pt ? placementSignalFromTest(pt) : null;
        })(),
      });

      // Feed the per-domain rollup: keep the worst (lowest) member score.
      if (mb.domain_id) {
        const cur = domainRollup.get(mb.domain_id);
        if (!cur || health.score < cur.score) {
          domainRollup.set(mb.domain_id, {
            score: health.score,
            band: health.band,
            components: health.components,
          });
        }
      }

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

  // Persist the per-domain health rollups (migration 00081). watch_streak counts
  // CONSECUTIVE DAYS in the 'watch' band (the future lifecycle cron tires a
  // domain at WATCH_STREAK_FOR_TIRED consecutive days): it advances at most once
  // per UTC day, and resets to 0 the moment the domain leaves 'watch' — a
  // 'critical' domain tires via the band directly, not via the streak. Purely
  // additive: nothing reads these columns yet except the (future) lifecycle cron.
  const rollupIso = new Date(now).toISOString();
  for (const [domainId, roll] of domainRollup) {
    const prior = priorDomain.get(domainId);
    const watchStreak = nextWatchStreak(
      roll.band,
      prior?.watch_streak ?? 0,
      prior?.health_checked_at ?? null,
      rollupIso,
    );
    const { error: rollErr } = await admin
      .from("sending_domains")
      .update({
        health_score: roll.score,
        health_band: roll.band,
        health_components: roll.components,
        health_checked_at: rollupIso,
        watch_streak: watchStreak,
      })
      .eq("id", domainId);
    if (rollErr) {
      tally.errors += 1;
      console.error(
        `[cron/check-inbox-health] domain rollup update failed for ${domainId}:`,
        rollErr.message,
      );
    } else {
      tally.domains_rolled += 1;
    }
  }

  return NextResponse.json(tally);
}
