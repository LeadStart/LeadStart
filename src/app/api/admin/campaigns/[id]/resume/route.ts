// POST /api/admin/campaigns/[id]/resume — mark a paused campaign 'active'
// again so the cron workers pick it back up. Owner or VA.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SourceChannel } from "@/types/app";
import { controlInstantlyCampaign } from "@/lib/instantly/campaign-lifecycle";

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
    .select("id, organization_id, source_channel, instantly_campaign_id, name, status")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | {
        id: string;
        organization_id: string;
        source_channel: SourceChannel;
        instantly_campaign_id: string | null;
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

  // Instantly campaigns resume on Instantly's side (activate covers resume) —
  // start upstream first, then mirror the status locally. Native/LinkedIn have
  // no upstream sequencer, so the local status flip alone is enough.
  if (c.source_channel === "instantly") {
    const result = await controlInstantlyCampaign(
      admin,
      c.organization_id,
      c.instantly_campaign_id,
      "activate",
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
  } else if (
    c.source_channel !== "native_email" &&
    c.source_channel !== "linkedin"
  ) {
    return NextResponse.json(
      { error: `Resume is not supported for ${c.source_channel} campaigns yet.` },
      { status: 501 },
    );
  }

  const { error: updateError } = await admin
    .from("campaigns")
    .update({ status: "active" })
    .eq("id", campaignId);
  if (updateError) {
    console.error(
      `[admin/campaigns/${campaignId}/resume] status update failed:`,
      updateError,
    );
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, status: "active" });
}
