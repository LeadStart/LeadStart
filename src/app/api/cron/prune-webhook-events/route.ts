import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// D3 — webhook_events retention cron. Daily at 4am UTC (see vercel.json).
//
// Deletes processed webhook_events older than 90 days. Keeps rows with
// `processed = false` regardless of age — per SAFETY-TODO Phase D, those
// are forensic gold for debugging stuck events and we never auto-drop
// them. A human can clean them up by hand once investigated.
//
// No batching: current table is in the low hundreds of rows and the
// composite (event_type, received_at) + partial (processed) indexes keep
// the scan cheap. If the table grows past 10k eligible rows in a single
// run, revisit with a chunked SELECT-then-DELETE loop.

const RETENTION_DAYS = 90;

export async function GET(request: NextRequest) {
  if (
    process.env.CRON_SECRET &&
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const cutoffIso = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await admin
    .from("webhook_events")
    .delete()
    .lt("received_at", cutoffIso)
    .eq("processed", true)
    .select("id");

  if (error) {
    console.error("prune-webhook-events failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    deleted: data?.length ?? 0,
    cutoff: cutoffIso,
    retention_days: RETENTION_DAYS,
  });
}
