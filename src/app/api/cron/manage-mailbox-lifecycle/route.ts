// GET /app/api/cron/manage-mailbox-lifecycle — runs hourly at :45 (vercel.json).
//
// The burn-prevention lifecycle driver (Phase 5 of the deliverability-
// infrastructure plan). For every sending domain it gathers the signals the
// state machine needs, calls the pure decideLifecycle() (see
// src/lib/deliverability/lifecycle.ts), and applies the transition plus its side
// effects:
//
//   → tired    close intake to NEW leads (the dispatcher's step-0 drain filter
//              already does this once the status flips); start the drain timer.
//              In-flight follow-ups keep sending.
//   → resting  pause every active mailbox on the domain (they stop sending), but
//              leave DNS/MX live so late replies still arrive; start the rest timer.
//   resting →  re-warm: resume the mailboxes the rest paused AND reset each one's
//   warming    ramp (ramp_baseline_sent = current all-time count) so it re-warms
//              from stage 1 instead of resuming at full cap.
//   → burned   pause the domain's mailboxes; alert the owner to replace it.
//
// Gated per-org by organizations.domain_lifecycle_enabled (migration 00082):
// OFF (default) → OBSERVE mode, it computes every decision and reports what it
// WOULD do but writes nothing; ON → it applies. Mirrors the inbox-health
// auto-pause opt-in. Runs after check-inbox-health (:30) so the domain health
// rollup it reads is fresh.
//
// Signals come from cheap, already-collected sources: the domain health rollup
// (health_band / watch_streak / health_components) written by check-inbox-health,
// the latest complete placement tests, and per-mailbox ramp state. No DNS/Gmail
// I/O here.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import {
  decideLifecycle,
  enterTimers,
  gatherDomainSignals,
  DRAIN_DAYS,
  REST_DAYS,
} from "@/lib/deliverability/lifecycle";
import { latestCompletePlacementTests } from "@/lib/deliverability/placement-runner";
import { PLACEMENT_FRESHNESS_DAYS } from "@/lib/deliverability/placement";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import type { DomainLifecycle, NativeMailbox, SendingDomain } from "@/types/app";

// force-dynamic so a Vercel cron never gets an edge-cached response (matches the
// other cron routes). Node runtime for the Supabase admin client.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const DAY_MS = 86_400_000;

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // 1) Every sending domain, all orgs. Terminal states (burned/retired) are
  // loaded too but decideLifecycle keeps them put.
  const { data: domainRows, error: domErr } = await admin
    .from("sending_domains")
    .select("*")
    .order("organization_id", { ascending: true });
  if (domErr) {
    return NextResponse.json({ error: domErr.message }, { status: 500 });
  }
  const domains = (domainRows ?? []) as SendingDomain[];
  if (domains.length === 0) {
    return NextResponse.json({ status: "idle", domains: 0 });
  }

  // 2) Per-org lifecycle gate (migration 00082). Missing/false → observe only.
  const orgIds = Array.from(new Set(domains.map((d) => d.organization_id)));
  const { data: orgRows, error: orgErr } = await admin
    .from("organizations")
    .select("id, domain_lifecycle_enabled")
    .in("id", orgIds);
  if (orgErr) {
    return NextResponse.json({ error: orgErr.message }, { status: 500 });
  }
  const enabledByOrg = new Map<string, boolean>(
    ((orgRows ?? []) as { id: string; domain_lifecycle_enabled: boolean | null }[]).map((o) => [
      o.id,
      o.domain_lifecycle_enabled ?? false,
    ]),
  );

  // 3) All mailboxes on these domains, grouped by domain_id. Needed for
  // allMailboxesWarmed (ramp graduation) and the pause/resume/ramp-reset side
  // effects.
  const domainIds = domains.map((d) => d.id);
  const { data: mbRows, error: mbErr } = await admin
    .from("native_mailboxes")
    .select("*")
    .in("domain_id", domainIds);
  if (mbErr) {
    return NextResponse.json({ error: mbErr.message }, { status: 500 });
  }
  const mailboxesByDomain = new Map<string, NativeMailbox[]>();
  for (const mb of (mbRows ?? []) as NativeMailbox[]) {
    if (!mb.domain_id) continue;
    const arr = mailboxesByDomain.get(mb.domain_id) ?? [];
    arr.push(mb);
    mailboxesByDomain.set(mb.domain_id, arr);
  }

  // 4) All-time send count per mailbox (count-only), for ramp graduation and the
  // ramp reset on re-warm. Small fleet; count queries are cheap. Only mailboxes
  // on warming/resting domains actually need it, but computing for all keeps the
  // code simple — revisit if the mailbox count grows large.
  const totalSent = new Map<string, number>();
  await Promise.all(
    ((mbRows ?? []) as NativeMailbox[]).map(async (mb) => {
      const { count } = await admin
        .from("native_sends")
        .select("id", { count: "exact", head: true })
        .eq("mailbox_id", mb.id);
      totalSent.set(mb.id, count ?? 0);
    }),
  );

  // 5) Latest complete placement test per mailbox (fresh), for the domain
  // placement aggregation. A read error → treat placement as unknown.
  const placementSince = new Date(now - PLACEMENT_FRESHNESS_DAYS * DAY_MS).toISOString();
  const placement = await latestCompletePlacementTests(admin, placementSince);

  const tally = {
    domains: domains.length,
    applied: 0,
    observed: 0, // transitions that WOULD fire but the org gate is off
    timers_backfilled: 0,
    mailboxes_paused: 0,
    mailboxes_resumed: 0,
    errors: 0,
  };
  const transitions: Array<{
    domain: string;
    from: DomainLifecycle;
    to: DomainLifecycle;
    reason: string;
    applied: boolean;
  }> = [];

  for (const domain of domains) {
    try {
      const mailboxes = mailboxesByDomain.get(domain.id) ?? [];
      const signals = gatherDomainSignals(domain, mailboxes, totalSent, placement.byMailbox, now);
      const timers = {
        drainUntil: domain.drain_until ? Date.parse(domain.drain_until) : null,
        restUntil: domain.rest_until ? Date.parse(domain.rest_until) : null,
      };
      const decision = decideLifecycle(domain.lifecycle_status, signals, now, timers);
      const enabled = enabledByOrg.get(domain.organization_id) ?? false;

      if (decision.changed) {
        transitions.push({
          domain: domain.domain,
          from: domain.lifecycle_status,
          to: decision.next,
          reason: decision.reason,
          applied: enabled,
        });
        if (!enabled) {
          tally.observed += 1;
          continue; // observe-only: compute + report, apply nothing
        }
        await applyTransition(admin, domain, decision.next, mailboxes, totalSent, now, nowIso, tally);
        tally.applied += 1;
      } else {
        // Staying put. Backfill a missing timer for a timed state (e.g. a domain
        // the future circuit breaker set 'tired' without one) so it can still
        // progress — but never RESET a running timer.
        if (!enabled) continue;
        const backfill = backfillTimer(domain, now);
        if (backfill) {
          const { error } = await admin.from("sending_domains").update(backfill).eq("id", domain.id);
          if (error) throw new Error(`timer backfill failed: ${error.message}`);
          tally.timers_backfilled += 1;
        }
      }
    } catch (err) {
      tally.errors += 1;
      console.error(
        `[cron/manage-mailbox-lifecycle] failed for ${domain.domain}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.json({ ...tally, transitions });
}

// ── Applying a transition + its side effects ────────────────────────────────

async function applyTransition(
  admin: ReturnType<typeof createAdminClient>,
  domain: SendingDomain,
  next: DomainLifecycle,
  mailboxes: NativeMailbox[],
  totalSent: Map<string, number>,
  now: number,
  nowIso: string,
  tally: { mailboxes_paused: number; mailboxes_resumed: number },
): Promise<void> {
  const timers = enterTimers(next, now);
  const update: Record<string, unknown> = {
    lifecycle_status: next,
    lifecycle_changed_at: nowIso,
    // Set the timer we're entering; clear the other (a transition never keeps a
    // stale timer from the prior state).
    drain_until: timers.drain_until ?? null,
    rest_until: timers.rest_until ?? null,
  };
  // Compare-and-set on the from-state: the reply poller's bounce circuit
  // breaker can tire this domain between our read and this write (both run
  // at :45), and an unguarded update would overwrite the trip and null its
  // drain timer (SEND_RUNTIME_AUDIT.md CRON-08). Zero rows = raced; skip the
  // mailbox side effects, the next hourly pass sees the real state.
  const { data: updated, error } = await admin
    .from("sending_domains")
    .update(update)
    .eq("id", domain.id)
    .eq("lifecycle_status", domain.lifecycle_status)
    .select("id");
  if (error) throw new Error(`sending_domains update failed: ${error.message}`);
  if (!updated || updated.length === 0) {
    console.warn(
      `[cron/mailbox-lifecycle] ${domain.domain}: transition ${domain.lifecycle_status} -> ${next} skipped, state changed concurrently`,
    );
    return;
  }

  // Side effects on the domain's mailboxes.
  if (next === "resting" || next === "burned") {
    // Pause every active mailbox — it stops sending. health_paused_at marks a
    // system pause (distinct from a manual one), so re-warm can safely resume it.
    const { data: paused, error: pauseErr } = await admin
      .from("native_mailboxes")
      .update({ status: "paused", health_paused_at: nowIso })
      .eq("domain_id", domain.id)
      .eq("status", "active")
      .select("id");
    if (pauseErr) throw new Error(`pause mailboxes failed: ${pauseErr.message}`);
    tally.mailboxes_paused += (paused ?? []).length;
  } else if (next === "warming" && domain.lifecycle_status === "resting") {
    // Re-warm after a rest: resume the mailboxes the rest paused (system-paused,
    // health_paused_at set — never a manually paused one) and RESET each ramp so
    // it re-warms from stage 1 rather than resuming at full cap.
    const toResume = mailboxes.filter(
      (m) => m.status === "paused" && m.health_paused_at != null,
    );
    for (const m of toResume) {
      const { error: resumeErr } = await admin
        .from("native_mailboxes")
        .update({
          status: "active",
          health_paused_at: null,
          ramp_baseline_sent: totalSent.get(m.id) ?? 0,
        })
        .eq("id", m.id);
      if (resumeErr) throw new Error(`resume mailbox ${m.id} failed: ${resumeErr.message}`);
      tally.mailboxes_resumed += 1;
    }
  }

  await alertTransition(admin, domain, next);
}

// Timer to backfill when a domain sits in a timed state with no timer set (e.g.
// the future circuit breaker tired it without one). Never resets a running timer.
function backfillTimer(domain: SendingDomain, now: number): Record<string, unknown> | null {
  if (domain.lifecycle_status === "tired" && !domain.drain_until) {
    return { drain_until: new Date(now + DRAIN_DAYS * DAY_MS).toISOString() };
  }
  if (domain.lifecycle_status === "resting" && !domain.rest_until) {
    return { rest_until: new Date(now + REST_DAYS * DAY_MS).toISOString() };
  }
  return null;
}

async function alertTransition(
  admin: ReturnType<typeof createAdminClient>,
  domain: SendingDomain,
  next: DomainLifecycle,
): Promise<void> {
  // Only the transitions an owner should know about. Warming→active is routine
  // and un-alerted.
  const messages: Partial<Record<DomainLifecycle, { subject: string; summary: string }>> = {
    tired: {
      subject: `Domain ${domain.domain} is draining (no new leads)`,
      summary: `${domain.domain} was closed to new first-touches to protect its reputation; in-flight follow-ups finish, then it rests. No action needed unless you want to investigate why it degraded.`,
    },
    resting: {
      subject: `Domain ${domain.domain} is now resting (mailboxes paused)`,
      summary: `${domain.domain}'s mailboxes were paused to let its reputation recover. DNS stays live so replies still arrive; it will re-warm automatically after the rest period.`,
    },
    warming: {
      subject: `Domain ${domain.domain} is re-warming`,
      summary: `${domain.domain} finished resting and its mailboxes resumed on a fresh warmup ramp (low daily volume, climbing). It returns to full duty once warmed and placement is clean.`,
    },
    burned: {
      subject: `Domain ${domain.domain} is burned — replace it`,
      summary: `${domain.domain} did not recover after a full rest (still blacklisted or landing in spam). Its mailboxes are paused. Retire it and provision a replacement.`,
    },
  };
  const msg = messages[next];
  if (!msg) return;
  await enqueueOwnerAlert({
    admin,
    kind: "domain_lifecycle",
    subject: msg.subject,
    summary: msg.summary,
    context: { domain: domain.domain, lifecycle: next },
  });
}
