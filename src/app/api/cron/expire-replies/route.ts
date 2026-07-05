import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";

// Force dynamic rendering on every invocation. Without this, a Vercel cron
// (which hits the same URL with no query params) can receive an edge-cached
// response from a prior tick, skipping the function body entirely — the DB
// is never touched but the route returns the old payload. Caught on
// 2026-05-27 in /api/cron/dispatch-salesforge-enrollments (commit 59b8745);
// applying the same guard to every cron route preemptively.
export const dynamic = "force-dynamic";

// Marks unresolved hot replies as `expired` after 48h with no outcome logged.
// Prevents stale "call this lead now" rows from cluttering the inbox after
// the realistic response window has closed. Scheduled every 6h in vercel.json.
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
