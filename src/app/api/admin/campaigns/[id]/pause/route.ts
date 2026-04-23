// POST /api/admin/campaigns/[id]/pause — pause an Instantly campaign and
// reflect the new status in our campaigns row. Owner or VA may pause.
// Reversible via the companion /resume route.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";

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
    .select("id, organization_id, instantly_campaign_id, name, status")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | {
        id: string;
        organization_id: string;
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
  if (!c.instantly_campaign_id) {
    return NextResponse.json(
      { error: "Campaign has no Instantly id — cannot pause remotely." },
      { status: 400 },
    );
  }

  const { data: org } = await admin
    .from("organizations")
    .select("instantly_api_key")
    .eq("id", c.organization_id)
    .maybeSingle();
  const apiKey = (org as { instantly_api_key: string | null } | null)
    ?.instantly_api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Instantly API key not set on organization." },
      { status: 400 },
    );
  }

  try {
    const client = new InstantlyClient(apiKey);
    await client.pauseCampaign(c.instantly_campaign_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[admin/campaigns/${campaignId}/pause] Instantly call failed:`,
      err,
    );
    return NextResponse.json(
      { error: `Instantly rejected the pause: ${message}` },
      { status: 502 },
    );
  }

  const { error: updateError } = await admin
    .from("campaigns")
    .update({ status: "paused" })
    .eq("id", campaignId);
  if (updateError) {
    console.error(
      `[admin/campaigns/${campaignId}/pause] Instantly paused but local update failed:`,
      updateError,
    );
    return NextResponse.json(
      {
        warning:
          "Paused on Instantly but local status update failed. Next sync will reconcile.",
        error: updateError.message,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({ success: true, status: "paused" });
}
