// Buyer contact RE-VERIFY.
//   GET  -> the re-verify summary: how many of the buyer's verified emails are
//           stale, the token cost, and any in-flight job.
//   POST -> enqueue a job: reserve the cost (hold) + insert a pending job the
//           reverify-buyer-contacts cron drains (Million Verifier re-checks). Sync
//           re-verify of a long list would time out, so it runs async.
//
// Charge basis: reverify_token_price per re-checked contact. The hold reserves the
// worst case (all stale x price); settlement charges only what actually got a
// verdict. Service-role, scoped to the buyer's org.

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBalance } from "@/lib/tokens/billing";

const MAX_JOB = 1000; // cap the stale set a single job re-verifies

type Cfg = { reverify_token_price: number | null; auto_reverify_days: number | null };

async function loadReverifyConfig(admin: ReturnType<typeof createAdminClient>): Promise<Cfg> {
  const { data } = await admin
    .from("token_pricing_config")
    .select("reverify_token_price, auto_reverify_days")
    .eq("singleton", true)
    .maybeSingle();
  const c = data as Cfg | null;
  return { reverify_token_price: c?.reverify_token_price ?? null, auto_reverify_days: c?.auto_reverify_days ?? null };
}

// Buyer's stale verified emails: status 'ok' with a verification older than the
// re-verify window (auto_reverify_days; 0 = any). Includes rows with no
// verified-at timestamp (unknown age). Returns up to MAX_JOB ids (the snapshot).
async function staleIds(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  autoReverifyDays: number | null,
): Promise<string[]> {
  const days = autoReverifyDays != null && autoReverifyDays > 0 ? autoReverifyDays : 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .not("email", "is", null)
    .eq("email_verification_status", "ok")
    .or(`email_verified_at.is.null,email_verified_at.lt.${cutoff}`)
    .order("email_verified_at", { ascending: true, nullsFirst: true })
    .limit(MAX_JOB);
  return ((data as { id: string }[] | null) ?? []).map((r) => r.id);
}

async function requireBuyer() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.app_metadata?.role !== "buyer") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return { error: NextResponse.json({ error: "No organization" }, { status: 400 }) };
  return { user, organizationId };
}

export async function GET() {
  const gate = await requireBuyer();
  if ("error" in gate) return gate.error;
  const admin = createAdminClient();

  const cfg = await loadReverifyConfig(admin);
  const { data: jobRow } = await admin
    .from("buyer_reverify_jobs")
    .select("id, status, total, processed, reverified, charged")
    .eq("organization_id", gate.organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const job = jobRow as { id: string; status: string; total: number; processed: number; reverified: number; charged: number | null } | null;
  const active = job && (job.status === "pending" || job.status === "running") ? job : null;

  if (cfg.reverify_token_price == null || !(cfg.reverify_token_price > 0)) {
    return NextResponse.json({ available: false, stale_count: 0, active_job: active, last_job: job });
  }
  const stale = (await staleIds(admin, gate.organizationId, cfg.auto_reverify_days)).length;
  return NextResponse.json({
    available: true,
    stale_count: stale,
    price_per: Number(cfg.reverify_token_price),
    cost: Math.ceil(Number(cfg.reverify_token_price) * stale),
    active_job: active,
    last_job: job,
  });
}

export async function POST() {
  const gate = await requireBuyer();
  if ("error" in gate) return gate.error;
  const admin = createAdminClient();

  const cfg = await loadReverifyConfig(admin);
  if (cfg.reverify_token_price == null || !(cfg.reverify_token_price > 0)) {
    return NextResponse.json({ error: "Re-verify isn't available yet." }, { status: 400 });
  }
  const ids = await staleIds(admin, gate.organizationId, cfg.auto_reverify_days);
  if (ids.length === 0) return NextResponse.json({ error: "No stale emails to re-verify." }, { status: 400 });

  const price = Number(cfg.reverify_token_price);
  const cost = Math.ceil(price * ids.length);
  const { available } = await getBalance(admin, gate.organizationId);
  if (available < cost) {
    return NextResponse.json({ error: `Not enough tokens. This needs ${cost}; your balance is ${available}.`, reason: "insufficient_tokens", cost }, { status: 400 });
  }

  // Reserve first (hold), then insert the job. The partial unique index blocks a
  // second active job; on that conflict, roll the hold back.
  const jobId = randomUUID();
  const { error: holdErr } = await admin.from("token_ledger").insert({
    organization_id: gate.organizationId,
    entry_type: "hold",
    tokens: cost,
    search_id: jobId,
  } as Record<string, unknown>);
  if (holdErr && !/duplicate key|unique/i.test(holdErr.message)) {
    return NextResponse.json({ error: "Could not reserve tokens." }, { status: 500 });
  }
  const { error: jobErr } = await admin.from("buyer_reverify_jobs").insert({
    id: jobId,
    organization_id: gate.organizationId,
    created_by: gate.user.id,
    status: "pending",
    contact_ids: ids,
    total: ids.length,
    reverify_price: price,
  } as Record<string, unknown>);
  if (jobErr) {
    await admin.from("token_ledger").delete().eq("search_id", jobId).eq("entry_type", "hold");
    const conflict = /duplicate|unique|23505/i.test(jobErr.message);
    return NextResponse.json(
      { error: conflict ? "A re-verify is already running." : "Could not start re-verify." },
      { status: conflict ? 409 : 500 },
    );
  }
  return NextResponse.json({ success: true, job_id: jobId, total: ids.length, held: cost });
}
