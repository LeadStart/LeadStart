import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { MillionVerifierClient, MillionVerifierError } from "@/lib/millionverifier/client";

// Force dynamic so a Vercel cron never gets an edge-cached body (see the note in
// prune-webhook-events).
export const dynamic = "force-dynamic";
// Explicit function budget (SEND_RUNTIME_AUDIT.md CRON-05): never rely on the
// project's Fluid-compute default (300s per Vercel's docs, read 2026-09-05).
export const maxDuration = 300;

// Phase 4 maintenance — MASTER-POOL RE-VERIFY.
//
// A verified email decays (~2-3%/month), so a contact resold from the master pool
// weeks after it was sourced can be undeliverable. This cron re-checks the pool's
// clean emails (email_verification_status = 'ok') that were last verified longer
// than token_pricing_config.master_reverify_cadence_days ago, via Million Verifier,
// and writes the fresh verdict back onto master_contacts. It touches ONLY the
// shared pool (the platform asset); a buyer's own per-org copies are their working
// data and are left alone.
//
// Fully gated + inert by default:
//   - no cadence set (NULL)        -> no-op
//   - no Million Verifier key      -> no-op
//   - no stale rows                -> no-op
// so it costs nothing until the owner opts in by setting a cadence, and even then
// only when the pool holds aged, verified rows.
//
// Bounded: at most BATCH emails per tick (MV is one paid call each), oldest first,
// and it stops the tick on any definitive MV account error (bad key / no credits /
// IP block) so a misconfig can't burn the whole run.

const BATCH = 100;

type MasterRow = {
  id: string;
  email: string | null;
  email_verified_at: string | null;
};

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // 1) cadence gate
  const { data: cfg } = await admin
    .from("token_pricing_config")
    .select("master_reverify_cadence_days")
    .eq("singleton", true)
    .maybeSingle();
  const cadenceDays = (cfg as { master_reverify_cadence_days?: number | null } | null)?.master_reverify_cadence_days ?? null;
  if (cadenceDays == null || !(cadenceDays > 0)) {
    return NextResponse.json({ skipped: "no_cadence" });
  }

  // 2) an MV key (the agency owns the pool, so use an agency key; fall back to any
  //    org that has one). No key => no-op.
  const { data: keyRows } = await admin
    .from("organizations")
    .select("kind, millionverifier_api_key")
    .not("millionverifier_api_key", "is", null)
    .limit(50);
  const keyed = (keyRows as { kind: string | null; millionverifier_api_key: string | null }[] | null) ?? [];
  const chosen = keyed.find((o) => o.kind === "agency" && o.millionverifier_api_key?.trim()) ?? keyed.find((o) => o.millionverifier_api_key?.trim());
  const mvKey = chosen?.millionverifier_api_key?.trim() || null;
  if (!mvKey) {
    return NextResponse.json({ skipped: "no_mv_key" });
  }

  // 3) stale, clean pool rows (oldest re-check first). Strip the millisecond dot
  //    from the cutoff — a PostgREST .or() filter parses `col.op.val` on dots, so a
  //    value containing one (…:56.789Z) would break the condition.
  const cutoffIso = new Date(Date.now() - cadenceDays * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const { data: rows } = await admin
    .from("master_contacts")
    .select("id, email, email_verified_at")
    .not("email", "is", null)
    .eq("email_verification_status", "ok")
    .or(`last_verified_at.is.null,last_verified_at.lt.${cutoffIso}`)
    .order("last_verified_at", { ascending: true, nullsFirst: true })
    .limit(BATCH);
  const stale = (rows as MasterRow[] | null) ?? [];
  if (stale.length === 0) {
    return NextResponse.json({ checked: 0, cutoff: cutoffIso, cadence_days: cadenceDays });
  }

  const mv = new MillionVerifierClient(mvKey);
  const now = new Date().toISOString();
  let checked = 0;
  let stillOk = 0;
  let degraded = 0;
  let skipped = 0;

  for (const row of stale) {
    if (!row.email) continue;
    let result: string;
    try {
      const res = await mv.verify(row.email, { timeoutSec: 15 });
      result = res.result;
    } catch (err) {
      if (err instanceof MillionVerifierError && err.definitive) {
        // bad key / no credits / IP block — stop the tick, leave the rest for later.
        return NextResponse.json({ checked, still_ok: stillOk, degraded, skipped, halted: "mv_account_error" });
      }
      skipped++; // transient (timeout / 5xx) — retry next tick, don't stamp it checked
      continue;
    }

    // 'unknown' / 'error' are inconclusive — don't downgrade a previously-clean row
    // or stamp it checked; it gets retried next tick.
    if (result === "unknown" || result === "error") {
      skipped++;
      continue;
    }

    const patch: Record<string, unknown> = {
      email_verification_status: result,
      last_verified_at: now,
      updated_at: now,
    };
    if (result === "ok") {
      patch.email_verified_at = now;
      stillOk++;
    } else {
      // catch_all / disposable / invalid — the address is no longer confirmed clean.
      degraded++;
    }
    await admin.from("master_contacts").update(patch).eq("id", row.id);
    checked++;
  }

  return NextResponse.json({ checked, still_ok: stillOk, degraded, skipped, cutoff: cutoffIso, cadence_days: cadenceDays });
}
