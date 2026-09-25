// GET /app/api/cron/check-inbox-health: runs hourly at :30 (vercel.json).
//
// Scores every native (Gmail) sending mailbox 0–100 from free signals: live
// SPF/DKIM/DMARC/MX DNS, the Spamhaus domain blocklist, the 7-day hard/soft
// bounce rates from native_sends, the per-contact reply-rate and opt-out
// signals (the app's own reply-rate definition, judged per sending domain:
// see src/lib/deliverability/engagement.ts), and the latest
// seed placement test (migration 00068; the one direct measurement): then:
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
  ENGAGEMENT_LOOKBACK_DAYS,
  computeContactEngagement,
  type ContactEngagement,
  type EngagementReplyRow,
  type FirstTouchRow,
} from "@/lib/deliverability/engagement";
import {
  latestCompletePlacementTests,
  placementSignalFromTest,
} from "@/lib/deliverability/placement-runner";
import { PLACEMENT_FRESHNESS_DAYS } from "@/lib/deliverability/placement";
import { nextCriticalStreak, nextWatchStreak } from "@/lib/deliverability/lifecycle";
import { fetchAllRowsStrict } from "@/lib/supabase/fetch-all";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import type { HealthBand, HealthComponent, NativeMailbox } from "@/types/app";

// See dispatch-owner-alerts/route.ts: force-dynamic so a Vercel cron never
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
  // with an empty org map: otherwise every mailbox would be scored with no
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

  // 2b) Prior domain rollup state (migration 00081): the watch_streak and last
  // check date, for the daily watch-streak accounting below. Keyed by domain_id.
  // A read error here is non-fatal: domains just start their streak fresh (the
  // rollup is advisory and nothing enforces on it yet).
  const domainIds = Array.from(
    new Set(mailboxes.map((m) => m.domain_id).filter((id): id is string => !!id)),
  );
  const priorDomain = new Map<
    string,
    { watch_streak: number; critical_streak: number; health_checked_at: string | null }
  >();
  // critical_streak arrives with migration 00132. select("*") (not a named
  // column list) so this read keeps working before that migration is applied;
  // the rollup write below includes critical_streak only once the column exists.
  let hasCriticalStreak = false;
  if (domainIds.length > 0) {
    const { data: domRows, error: domErr } = await admin
      .from("sending_domains")
      .select("*")
      .in("id", domainIds);
    if (domErr) {
      console.error("[cron/check-inbox-health] prior domain-rollup read failed:", domErr.message);
    } else {
      for (const d of (domRows ?? []) as {
        id: string;
        watch_streak: number | null;
        critical_streak?: number | null;
        health_checked_at: string | null;
      }[]) {
        if ("critical_streak" in d) hasCriticalStreak = true;
        priorDomain.set(d.id, {
          watch_streak: d.watch_streak ?? 0,
          critical_streak: d.critical_streak ?? 0,
          health_checked_at: d.health_checked_at,
        });
      }
    }
  }

  // 3) Send stats per mailbox from ONE 7-day sweep of native_sends: the hard +
  // soft bounce counts. Same reasoning as above: a read error here would
  // silently zero every mailbox, so fail the run rather than score on bad data.
  // PAGED: PostgREST silently truncates an un-ranged select at 1,000 rows on
  // this project; at 20/day a busy fleet passes that, and the dropped rows
  // would score bounce rates on partial data without an error (the SEND-68 bug
  // class). The strict pager throws rather than return a partial set.
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 86_400_000).toISOString();
  let sendRows: {
    mailbox_id: string;
    status: string;
    soft_bounced_at: string | null;
  }[];
  try {
    sendRows = await fetchAllRowsStrict(() =>
      admin
        .from("native_sends")
        .select("mailbox_id, status, soft_bounced_at")
        .gte("sent_at", sevenDaysAgo)
        .order("id", { ascending: true }),
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  interface SendStats {
    sent7d: number;
    bounced7d: number;
    softBounced7d: number;
  }
  const statsByMailbox = new Map<string, SendStats>();
  for (const s of sendRows) {
    const cur = statsByMailbox.get(s.mailbox_id) ?? { sent7d: 0, bounced7d: 0, softBounced7d: 0 };
    cur.sent7d += 1;
    if (s.status === "bounced") cur.bounced7d += 1;
    if (s.soft_bounced_at) cur.softBounced7d += 1;
    statsByMailbox.set(s.mailbox_id, cur);
  }

  // 3b) Per-contact engagement (reply-rate + opt-out signals) on the app's own
  // reply-rate definition (./engagement.ts): each org's first emails (step-0
  // sends) and native replies within the lookback, judged per sending domain.
  // Advisory: a read error leaves both signals unchecked, never a false "no
  // replies". Replies flagged excluded_from_stats are left out, as the app's
  // reply-rate metrics do (sync-analytics).
  const engagementByOrg = new Map<string, (domain: string) => ContactEngagement>();
  try {
    const lookback = new Date(now - ENGAGEMENT_LOOKBACK_DAYS * 86_400_000).toISOString();
    const [touchRows, replyRows] = await Promise.all([
      fetchAllRowsStrict<{ mailbox_id: string; to_email: string | null; sent_at: string | null }>(() =>
        admin
          .from("native_sends")
          .select("mailbox_id, to_email, sent_at")
          .eq("step_index", 0)
          .gte("sent_at", lookback)
          .order("id", { ascending: true }),
      ),
      fetchAllRowsStrict<{
        organization_id: string;
        lead_email: string | null;
        received_at: string | null;
        final_class: string | null;
      }>(() =>
        admin
          .from("lead_replies")
          .select("organization_id, lead_email, received_at, final_class")
          .eq("source_channel", "native_email")
          .eq("excluded_from_stats", false)
          .gte("received_at", lookback)
          .order("id", { ascending: true }),
      ),
    ]);
    const mailboxById = new Map(mailboxes.map((m) => [m.id, m]));
    const touchesByOrg = new Map<string, FirstTouchRow[]>();
    for (const s of touchRows) {
      const mb = mailboxById.get(s.mailbox_id);
      if (!mb) continue; // a deleted mailbox's sends can't be tied to a domain
      const list = touchesByOrg.get(mb.organization_id) ?? [];
      list.push({ to_email: s.to_email, sent_at: s.sent_at, domain: domainOf(mb.email_address) });
      touchesByOrg.set(mb.organization_id, list);
    }
    const repliesByOrg = new Map<string, EngagementReplyRow[]>();
    for (const r of replyRows) {
      const list = repliesByOrg.get(r.organization_id) ?? [];
      list.push(r);
      repliesByOrg.set(r.organization_id, list);
    }
    for (const orgId of orgIds) {
      engagementByOrg.set(
        orgId,
        computeContactEngagement(touchesByOrg.get(orgId) ?? [], repliesByOrg.get(orgId) ?? [], now),
      );
    }
  } catch (err) {
    console.error(
      "[cron/check-inbox-health] engagement read failed (reply + opt-out signals unchecked):",
      err instanceof Error ? err.message : err,
    );
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
  // (lowest-scoring) member mailbox: the weakest inbox is the burn risk. The
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
        // Domain-level, like DNS: every mailbox on the domain gets the same
        // verdict. A failed read → null → unchecked (never a false "no replies").
        engagement: engagementByOrg.get(mb.organization_id)?.(domain) ?? null,
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
  // CONSECUTIVE DAYS in the 'watch' band (the lifecycle cron tires a domain at
  // WATCH_STREAK_FOR_TIRED consecutive days): it advances at most once per UTC
  // day, and resets to 0 the moment the domain leaves 'watch'. critical_streak
  // (migration 00132) counts consecutive HOURLY rollups in 'critical': the
  // lifecycle acts on a critical band only at CRITICAL_STREAK_FOR_TIRED, so a
  // one-hour blip never tires a domain. Written only once that column exists.
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
        ...(hasCriticalStreak
          ? { critical_streak: nextCriticalStreak(roll.band, prior?.critical_streak ?? 0) }
          : {}),
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
