// POST /api/admin/campaigns/[id]/pause — pause the campaign on its
// upstream provider (Instantly or Salesforge) and reflect the new status
// in our campaigns row. Owner or VA. Reversible via the companion
// /resume route.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";
import { SalesforgeClient } from "@/lib/salesforge/client";
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
    .select(
      "id, organization_id, source_channel, instantly_campaign_id, salesforge_sequence_id, name, status",
    )
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | {
        id: string;
        organization_id: string;
        source_channel: SourceChannel;
        instantly_campaign_id: string | null;
        salesforge_sequence_id: string | null;
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

  const { data: org } = await admin
    .from("organizations")
    .select("instantly_api_key, salesforge_api_key")
    .eq("id", c.organization_id)
    .maybeSingle();
  const orgRow = org as
    | { instantly_api_key: string | null; salesforge_api_key: string | null }
    | null;

  try {
    if (c.source_channel === "instantly") {
      if (!c.instantly_campaign_id) {
        return NextResponse.json(
          { error: "Campaign has no Instantly id — cannot pause remotely." },
          { status: 400 },
        );
      }
      if (!orgRow?.instantly_api_key) {
        return NextResponse.json(
          { error: "Instantly API key not set on organization." },
          { status: 400 },
        );
      }
      const client = new InstantlyClient(orgRow.instantly_api_key);
      await client.pauseCampaign(c.instantly_campaign_id);
    } else if (c.source_channel === "salesforge") {
      if (!c.salesforge_sequence_id) {
        return NextResponse.json(
          { error: "Campaign has no Salesforge sequence id — cannot pause remotely." },
          { status: 400 },
        );
      }
      if (!orgRow?.salesforge_api_key) {
        return NextResponse.json(
          { error: "Salesforge API key not set on organization." },
          { status: 400 },
        );
      }
      const client = new SalesforgeClient(orgRow.salesforge_api_key);
      await client.pauseSequence(c.salesforge_sequence_id);
    } else {
      return NextResponse.json(
        { error: `Pause is not supported for ${c.source_channel} campaigns yet.` },
        { status: 501 },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[admin/campaigns/${campaignId}/pause] upstream call failed:`,
      err,
    );
    return NextResponse.json(
      { error: `Upstream rejected the pause: ${message}` },
      { status: 502 },
    );
  }

  const { error: updateError } = await admin
    .from("campaigns")
    .update({ status: "paused" })
    .eq("id", campaignId);
  if (updateError) {
    console.error(
      `[admin/campaigns/${campaignId}/pause] upstream paused but local update failed:`,
      updateError,
    );
    return NextResponse.json(
      {
        warning:
          "Paused upstream but local status update failed. Next sync will reconcile.",
        error: updateError.message,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({ success: true, status: "paused" });
}
