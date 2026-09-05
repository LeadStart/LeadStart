// Per-org Million Verifier tick lifecycle: load the key + error/credit state at
// the top of a run-native-sequences tick, and persist the credit balance +
// error streak and fire edge-triggered owner alerts at the bottom.
//
// Kept out of policy.ts/client.ts so those stay pure (unit-tested via tsx); this
// module is the one with runtime @/ imports (Supabase admin client + owner
// alerts) and is exercised end-to-end via the cron, not a unit test.

import type { createAdminClient } from "@/lib/supabase/admin";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import { MillionVerifierClient } from "./client";
import {
  ORG_ERROR_SUPPRESS_MS,
  VERIFY_DEADLINE_MS,
  shouldAlertAccountError,
  shouldAlertLowCredits,
} from "./policy";
import type { VerifierTickState } from "./verify-contact";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface VerifierTickSummary {
  organization_id: string;
  mode: "disarmed" | "armed" | "suppressed" | "tripped";
  calls: number;
  cached: number;
  held: number;
  skipped: number;
  credits: number | null;
  counts: Record<string, number>;
}

interface OrgVerifierRow {
  id: string;
  millionverifier_api_key: string | null;
  millionverifier_credits: number | null;
  millionverifier_last_error_kind: string | null;
  millionverifier_last_error_at: string | null;
  millionverifier_error_streak: number | null;
}

// Thrown when the per-org verifier state cannot be read. The send worker treats
// it as "abort this tick" (fail closed): sends wait five minutes rather than go
// out unverified.
export class VerifierStateLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierStateLoadError";
  }
}

// Read each org's verifier state for this tick. FAIL CLOSED: any error reading
// the organizations row throws, and the worker aborts the tick, because the
// old "log and return an empty map" stance disarmed the gate on ANY error (a
// transient PostgREST 5xx included) and let every uncached address go out
// unverified with nothing but a console line (SEND_RUNTIME_AUDIT.md SEND-51).
// The one deliberate exception is the pre-migration-00069 "column does not
// exist" case (Postgres 42703), which still disarms so a schema lag cannot
// stop all sending; 00069 is live in production, so that branch is dormant.
export async function loadVerifierStates(
  admin: AdminClient,
  orgIds: string[],
  tickNow: Date,
): Promise<Map<string, VerifierTickState>> {
  const states = new Map<string, VerifierTickState>();
  if (orgIds.length === 0) return states;

  const { data, error } = await admin
    .from("organizations")
    .select(
      "id, millionverifier_api_key, millionverifier_credits, millionverifier_last_error_kind, millionverifier_last_error_at, millionverifier_error_streak",
    )
    .in("id", orgIds);

  if (error) {
    if (error.code === "42703") {
      console.error(
        "[millionverifier] verifier columns missing (migration 00069 not applied); gate disarmed this tick:",
        error.message ?? error,
      );
      return states;
    }
    throw new VerifierStateLoadError(
      `loadVerifierStates failed: ${error.message ?? String(error)}`,
    );
  }

  const envKey = process.env.MILLIONVERIFIER_API_KEY?.trim() || null;
  const deadlineMs = tickNow.getTime() + VERIFY_DEADLINE_MS;

  for (const row of (data ?? []) as OrgVerifierRow[]) {
    const key = row.millionverifier_api_key?.trim() || envKey;
    const kind = row.millionverifier_last_error_kind;
    const definitive = !!kind && kind !== "transient";

    let suppressedUntilMs: number | null = null;
    if (definitive && row.millionverifier_last_error_at) {
      const at = Date.parse(row.millionverifier_last_error_at);
      if (!Number.isNaN(at)) suppressedUntilMs = at + ORG_ERROR_SUPPRESS_MS;
    }

    states.set(row.id, {
      organizationId: row.id,
      client: key ? new MillionVerifierClient(key) : null,
      suppressedUntilMs,
      deadlineMs,
      tripped: false,
      calls: 0,
      cached: 0,
      held: 0,
      skipped: 0,
      counts: {},
      prevCredits: row.millionverifier_credits ?? null,
      lastCredits: row.millionverifier_credits ?? null,
      prevErrorStreak: row.millionverifier_error_streak ?? 0,
      successThisTick: false,
      errorKind: null,
      errorMessage: null,
    });
  }

  return states;
}

// Persist the tick's outcome per org and enqueue any edge-triggered owner
// alerts. Never throws: a broken alert/persist path must not break the cron.
export async function finalizeVerifierStates(
  admin: AdminClient,
  states: Map<string, VerifierTickState>,
): Promise<VerifierTickSummary[]> {
  const summaries: VerifierTickSummary[] = [];
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  for (const st of states.values()) {
    const mode: VerifierTickSummary["mode"] =
      st.client == null
        ? "disarmed"
        : st.errorKind != null
          ? "tripped"
          : st.suppressedUntilMs != null && nowMs < st.suppressedUntilMs
            ? "suppressed"
            : "armed";

    summaries.push({
      organization_id: st.organizationId,
      mode,
      calls: st.calls,
      cached: st.cached,
      held: st.held,
      skipped: st.skipped,
      credits: st.lastCredits,
      counts: st.counts,
    });

    if (st.client == null) continue;

    try {
      const patch: Record<string, unknown> = {};

      // Refresh the cached credit balance when we learned a newer one.
      if (st.lastCredits != null && st.lastCredits !== st.prevCredits) {
        patch.millionverifier_credits = st.lastCredits;
        patch.millionverifier_credits_checked_at = nowIso;
      }

      // Error streak: increment on a failing tick, reset on a clean success.
      let newStreak = st.prevErrorStreak;
      if (st.errorKind) {
        newStreak = st.prevErrorStreak + 1;
        patch.millionverifier_error_streak = newStreak;
        patch.millionverifier_last_error = st.errorMessage;
        patch.millionverifier_last_error_kind = st.errorKind;
        patch.millionverifier_last_error_at = nowIso;
      } else if (st.successThisTick && st.prevErrorStreak > 0) {
        newStreak = 0;
        patch.millionverifier_error_streak = 0;
        patch.millionverifier_last_error = null;
        patch.millionverifier_last_error_kind = null;
        patch.millionverifier_last_error_at = null;
      }

      if (Object.keys(patch).length > 0) {
        const { error } = await admin
          .from("organizations")
          .update(patch)
          .eq("id", st.organizationId);
        if (error) {
          console.error(
            `[millionverifier] failed to persist org state for ${st.organizationId}:`,
            error.message ?? error,
          );
        }
      }

      // Edge-triggered owner alerts.
      if (st.errorKind && shouldAlertAccountError(st.errorKind, newStreak)) {
        await enqueueOwnerAlert({
          admin,
          kind: "email_verifier_unavailable",
          subject: "Email verifier unavailable, new sends on hold",
          summary:
            st.errorKind === "credits"
              ? "Million Verifier is out of credits. New first-touch sends are held until it's topped up."
              : st.errorKind === "auth"
                ? "Million Verifier rejected the API key. New first-touch sends are held until the key is fixed."
                : st.errorKind === "blocked"
                  ? "This server's IP is blocked by Million Verifier. New first-touch sends are held."
                  : "Million Verifier is unreachable. New first-touch sends are held until it recovers.",
          context: {
            organization_id: st.organizationId,
            error_kind: st.errorKind,
            error: st.errorMessage,
            streak: newStreak,
            credits: st.lastCredits,
          },
        });
      }

      if (st.lastCredits != null && shouldAlertLowCredits(st.prevCredits, st.lastCredits)) {
        await enqueueOwnerAlert({
          admin,
          kind: "email_verifier_credits_low",
          subject: "Email verifier credits low",
          summary: `Million Verifier is down to ${st.lastCredits} credits. Top up before it runs out and holds new sends.`,
          context: {
            organization_id: st.organizationId,
            credits: st.lastCredits,
          },
        });
      }
    } catch (err) {
      console.error("[millionverifier] finalizeVerifierStates failed for org", st.organizationId, err);
    }
  }

  return summaries;
}
