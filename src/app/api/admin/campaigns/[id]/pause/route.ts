// POST /api/admin/campaigns/[id]/pause: flip an active campaign to 'paused'
// so the cron workers stop dispatching it. Owner or VA. Reversible via the
// companion /resume route. Only active campaigns pause (lifecycle.ts): a draft
// launches through /activate, a completed one reopens through /resume.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { transitionRefusal } from "@/lib/campaigns/lifecycle";
import type { SourceChannel } from "@/types/app";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return NextResponse.json(
      { error: "Owner or VA role required" },
      { status: 403 },
    );
  }

  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel, name, status")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | {
        id: string;
        organization_id: string;
        source_channel: SourceChannel;
        name: string;
        status: string | null;
      }
    | null;
  if (!c) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (c.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Native/LinkedIn have no upstream sequencer, so the local status flip alone
  // is enough (the cron workers only dispatch status='active' campaigns).
  if (
    c.source_channel !== "native_email" &&
    c.source_channel !== "linkedin"
  ) {
    return NextResponse.json(
      { error: `Pause is not supported for ${c.source_channel} campaigns yet.` },
      { status: 501 },
    );
  }

  const refusal = transitionRefusal("pause", c.status);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });

  // Compare-and-swap on the status just read, so a complete landing in between
  // is never silently overwritten.
  const { data: updated, error: updateError } = await admin
    .from("campaigns")
    .update({ status: "paused" })
    .eq("id", campaignId)
    .eq("status", "active")
    .select("id");
  if (updateError) {
    console.error(
      `[admin/campaigns/${campaignId}/pause] status update failed:`,
      updateError,
    );
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: "The campaign's status just changed. Refresh and try again." },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true, status: "paused" });
}
