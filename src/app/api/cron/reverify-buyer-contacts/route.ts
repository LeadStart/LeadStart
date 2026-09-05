import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { MillionVerifierClient, MillionVerifierError } from "@/lib/millionverifier/client";

export const dynamic = "force-dynamic";
// Explicit function budget (SEND_RUNTIME_AUDIT.md CRON-05): never rely on the
// project's Fluid-compute default (300s per Vercel's docs, read 2026-09-05).
export const maxDuration = 60;

// Drains buyer RE-VERIFY jobs (buyer_reverify_jobs). A buyer enqueues a job with a
// snapshot of their stale verified-email contact ids + a token hold; this cron
// re-checks a batch per tick via Million Verifier (the platform's key), writes the
// fresh verdict onto each contact, and on completion charges reverify_token_price
// per re-checked contact + releases the rest of the hold. One job at a time, oldest
// first, capped at BATCH per tick so a long list can't blow the cron budget.

const BATCH = 20;

type JobRow = {
  id: string;
  organization_id: string;
  status: string;
  contact_ids: string[] | null;
  total: number;
  processed: number;
  reverified: number;
  reverify_price: number | null;
};

async function loadAgencyMvKey(admin: ReturnType<typeof createAdminClient>): Promise<string | null> {
  const { data } = await admin
    .from("organizations")
    .select("kind, millionverifier_api_key")
    .not("millionverifier_api_key", "is", null)
    .limit(50);
  const keyed = (data as { kind: string | null; millionverifier_api_key: string | null }[] | null) ?? [];
  const chosen = keyed.find((o) => o.kind === "agency" && o.millionverifier_api_key?.trim()) ?? keyed.find((o) => o.millionverifier_api_key?.trim());
  return chosen?.millionverifier_api_key?.trim() || null;
}

// Fully refund a job's hold (no charge) and mark it failed.
async function failAndRefund(admin: ReturnType<typeof createAdminClient>, job: JobRow, reason: string) {
  const now = new Date().toISOString();
  const { data: holdRow } = await admin.from("token_ledger").select("tokens").eq("search_id", job.id).eq("entry_type", "hold").maybeSingle();
  const hold = Number((holdRow as { tokens: number } | null)?.tokens ?? 0);
  if (hold > 0) {
    await admin.from("token_ledger").insert({ organization_id: job.organization_id, entry_type: "release", tokens: hold, search_id: job.id } as Record<string, unknown>);
  }
  await admin.from("buyer_reverify_jobs").update({ status: "failed", error: reason, completed_at: now, updated_at: now }).eq("id", job.id);
}

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;
  const admin = createAdminClient();

  const { data: jobRow } = await admin
    .from("buyer_reverify_jobs")
    .select("id, organization_id, status, contact_ids, total, processed, reverified, reverify_price")
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const job = jobRow as JobRow | null;
  if (!job) return NextResponse.json({ idle: true });

  const now = new Date().toISOString();
  if (job.status === "pending") {
    await admin.from("buyer_reverify_jobs").update({ status: "running", updated_at: now }).eq("id", job.id);
  }

  const mvKey = await loadAgencyMvKey(admin);
  if (!mvKey) {
    await failAndRefund(admin, job, "no_mv_key");
    return NextResponse.json({ job_id: job.id, failed: "no_mv_key" });
  }

  const ids = job.contact_ids ?? [];
  const slice = ids.slice(job.processed, job.processed + BATCH);
  if (slice.length === 0) {
    // Nothing left to process -> settle immediately.
    return NextResponse.json(await settle(admin, job, job.processed, job.reverified, now));
  }

  const { data: contacts } = await admin.from("contacts").select("id, email").in("id", slice);
  const byId = new Map(((contacts as { id: string; email: string | null }[] | null) ?? []).map((c) => [c.id, c]));

  const mv = new MillionVerifierClient(mvKey);
  let reverified = job.reverified;
  let doneInSlice = 0;
  let halted = false;

  for (const id of slice) {
    const c = byId.get(id);
    if (c?.email) {
      let result: string | null;
      try {
        result = (await mv.verify(c.email, { timeoutSec: 15 })).result;
      } catch (err) {
        if (err instanceof MillionVerifierError && err.definitive) {
          halted = true; // MV account error: stop, retry this id next tick
          break;
        }
        result = null; // transient: inconclusive, count as attempted
      }
      if (result && result !== "unknown" && result !== "error") {
        const patch: Record<string, unknown> = { email_verification_status: result };
        if (result === "ok") patch.email_verified_at = now;
        await admin.from("contacts").update(patch).eq("id", id);
        reverified++;
      }
    }
    doneInSlice++;
  }

  const processed = job.processed + doneInSlice;
  if (halted) {
    await admin.from("buyer_reverify_jobs").update({ processed, reverified, updated_at: now }).eq("id", job.id);
    return NextResponse.json({ job_id: job.id, halted: "mv_account_error", processed, reverified });
  }
  if (processed >= job.total) {
    return NextResponse.json(await settle(admin, job, processed, reverified, now));
  }
  await admin.from("buyer_reverify_jobs").update({ processed, reverified, updated_at: now }).eq("id", job.id);
  return NextResponse.json({ job_id: job.id, processed, reverified });
}

// Charge reverify_price x reverified, release the rest of the hold, complete the job.
async function settle(
  admin: ReturnType<typeof createAdminClient>,
  job: JobRow,
  processed: number,
  reverified: number,
  now: string,
) {
  const charge = Math.ceil(Number(job.reverify_price ?? 0) * reverified);
  const { data: holdRow } = await admin.from("token_ledger").select("tokens").eq("search_id", job.id).eq("entry_type", "hold").maybeSingle();
  const hold = Number((holdRow as { tokens: number } | null)?.tokens ?? 0);
  const charged = Math.min(hold, Math.max(0, charge));
  const release = Math.max(0, hold - charged);
  await admin.from("token_ledger").insert({ organization_id: job.organization_id, entry_type: "charge", tokens: charged, search_id: job.id, notes: "reverify" } as Record<string, unknown>);
  await admin.from("token_ledger").insert({ organization_id: job.organization_id, entry_type: "release", tokens: release, search_id: job.id } as Record<string, unknown>);
  await admin
    .from("buyer_reverify_jobs")
    .update({ status: "complete", processed, reverified, charged, completed_at: now, updated_at: now })
    .eq("id", job.id);
  return { job_id: job.id, done: true, reverified, charged };
}
