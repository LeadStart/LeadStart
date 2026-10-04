// POST /api/admin/campaigns/[id]/complete: mark an active or paused campaign
// 'completed'. Sending stops (the cron workers only dispatch active campaigns)
// and its inboxes go back to the pool for other campaigns (mailbox-usage.ts
// counts every campaign that is not completed). Enrollments stay as they are, so
// a reopen (POST /resume) picks contacts up where they stopped. Owner or VA.
//
// GET: what completing (or reopening) touches, for the confirm dialog: the
// campaign's inboxes, how many contacts are still mid-sequence, and which of its
// inboxes another campaign now holds (those block a reopen).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { lifecycleSummary, transitionRefusal } from "@/lib/campaigns/lifecycle";
import type { SourceChannel } from "@/types/app";

type CampaignRow = {
  id: string;
  organization_id: string;
  source_channel: SourceChannel;
  name: string;
  status: string | null;
};

type Loaded =
  | { campaign: CampaignRow; admin: ReturnType<typeof createAdminClient> }
  | { response: NextResponse };

// Auth, org scope, and the local-channel check, shared by GET and POST.
async function loadCampaign(campaignId: string): Promise<Loaded> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return {
      response: NextResponse.json({ error: "Owner or VA role required" }, { status: 403 }),
    };
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel, name, status")
    .eq("id", campaignId)
    .maybeSingle();
  const campaign = data as CampaignRow | null;
  if (!campaign) {
    return { response: NextResponse.json({ error: "Campaign not found" }, { status: 404 }) };
  }
  if (campaign.organization_id !== user.app_metadata?.organization_id) {
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (campaign.source_channel !== "native_email" && campaign.source_channel !== "linkedin") {
    return {
      response: NextResponse.json(
        { error: `Completing isn't supported for ${campaign.source_channel} campaigns.` },
        { status: 501 },
      ),
    };
  }
  return { campaign, admin };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;
  const loaded = await loadCampaign(campaignId);
  if ("response" in loaded) return loaded.response;
  const { campaign, admin } = loaded;

  try {
    const summary = await lifecycleSummary(admin, campaign.organization_id, campaign.id);
    return NextResponse.json({ status: campaign.status, ...summary });
  } catch (err) {
    console.error(`[admin/campaigns/${campaignId}/complete] summary failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load the campaign" },
      { status: 500 },
    );
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;
  const loaded = await loadCampaign(campaignId);
  if ("response" in loaded) return loaded.response;
  const { campaign, admin } = loaded;

  const refusal = transitionRefusal("complete", campaign.status);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });

  // Compare-and-swap on the status just read, so a pause or resume landing in
  // between is never silently overwritten.
  const { data: updated, error: updateError } = await admin
    .from("campaigns")
    .update({ status: "completed" })
    .eq("id", campaignId)
    .eq("status", campaign.status as string)
    .select("id");
  if (updateError) {
    console.error(`[admin/campaigns/${campaignId}/complete] status update failed:`, updateError);
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: "The campaign's status just changed. Refresh and try again." },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true, status: "completed" });
}
