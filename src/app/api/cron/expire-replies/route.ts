import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";

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
