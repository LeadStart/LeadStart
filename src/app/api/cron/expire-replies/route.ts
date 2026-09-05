import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";

// Force dynamic rendering on every invocation. Without this, a Vercel cron
// (which hits the same URL with no query params) can receive an edge-cached
// response from a prior tick, skipping the function body entirely: the DB
// is never touched but the route returns the old payload. Caught on
// 2026-05-27 in an earlier cron route;
// applying the same guard to every cron route preemptively.
// Schedule: once a day at 06:00 UTC (vercel.json `0 6 * * *`), so the
// effective expiry latency is 48-72h. (An older comment said "every 6h".)
export const dynamic = "force-dynamic";
// Explicit function budget (SEND_RUNTIME_AUDIT.md CRON-05): never rely on the
// project's Fluid-compute default (300s per Vercel's docs, read 2026-09-05).
export const maxDuration = 60;

// Marks unresolved hot replies as `expired` after 48h with no outcome logged.
// Prevents stale "call this lead now" rows from cluttering the inbox after
// the realistic response window has closed. Scheduled daily (06:00 UTC) in vercel.json.
export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data, error } = await admin
    .from("lead_replies")
    .update({ status: "expired" })
    .in("status", ["new", "classified"])
    .lt("received_at", cutoff)
    .is("outcome", null)
    .select("id");

  if (error) {
    console.error("expire-replies failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ expired: data?.length ?? 0, cutoff });
}
