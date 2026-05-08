// PUT /api/admin/salesforge/sequences/[id]/schedule
//
// Updates the sequence's sending-window schedule. Body shape:
//   { schedules: [{ weekday: 0..6, fromHour: 0..23, toHour: 0..23 }] }
//
// `weekday` is Sunday=0..Saturday=6. Hours are local to the sequence's
// timezone (set when the sequence was created). Replaces any existing
// schedule. Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveSalesforgeOwnerContext,
  callSalesforge,
} from "@/lib/salesforge/route-helpers";
import type { SalesforgeSchedule } from "@/lib/salesforge/types";

interface ScheduleBody {
  schedules?: Array<{
    weekday?: number;
    fromHour?: number;
    toHour?: number;
  }>;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;

  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel, salesforge_sequence_id")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | { id: string; organization_id: string; source_channel: string; salesforge_sequence_id: string | null }
    | null;
  if (!c) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (c.organization_id !== r.ctx.organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (c.source_channel !== "salesforge" || !c.salesforge_sequence_id) {
    return NextResponse.json(
      { error: "Campaign has no salesforge_sequence_id" },
      { status: 400 },
    );
  }

  let body: ScheduleBody;
  try {
    body = (await req.json()) as ScheduleBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.schedules)) {
    return NextResponse.json({ error: "schedules array is required" }, { status: 400 });
  }
  const schedules: SalesforgeSchedule[] = body.schedules
    .filter(
      (s): s is { weekday: number; fromHour: number; toHour: number } =>
        typeof s.weekday === "number" &&
        typeof s.fromHour === "number" &&
        typeof s.toHour === "number",
    )
    .map((s) => ({
      weekday: Math.max(0, Math.min(6, Math.floor(s.weekday))),
      fromHour: Math.max(0, Math.min(23, Math.floor(s.fromHour))),
      toHour: Math.max(0, Math.min(23, Math.floor(s.toHour))),
    }));

  const result = await callSalesforge("updateSequenceSchedules", () =>
    r.ctx.client.updateSequenceSchedules(
      r.ctx.workspaceId,
      c.salesforge_sequence_id!,
      schedules,
    ),
  );
  if (!result.ok) return result.response;

  return NextResponse.json({ success: true, schedules });
}
