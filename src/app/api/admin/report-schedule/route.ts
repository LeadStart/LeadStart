import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  const { client_id, interval_days, schedule_start, recipients } = await request.json();

  if (!client_id) {
    return NextResponse.json({ error: "client_id required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Build update object — only include fields that were provided
  const update: Record<string, unknown> = {};

  if (interval_days !== undefined) {
    // 0 or null means "off"
    update.report_interval_days = interval_days || null;
  }

  if (schedule_start !== undefined) {
    update.report_schedule_start = schedule_start || null;
  }

  if (recipients !== undefined) {
    update.report_recipients = recipients && recipients.length > 0 ? recipients : null;
  }

  const { error } = await admin
    .from("clients")
    .update(update)
    .eq("id", client_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
