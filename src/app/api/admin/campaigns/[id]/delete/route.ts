// POST /api/admin/campaigns/[id]/delete — delete the campaign from
// Instantly AND drop the local row. Owner only (matches the pattern for
// sync-campaigns, team management, client-user provisioning — anything
// irreversible or destructive). Requires the client to have already
// completed the typed-confirmation dialog on the UI; this route does
// NOT duplicate that check server-side (the confirm is a UX belt, not
// an auth mechanism).
//
// FK safety: campaign_snapshots / lead_feedback / campaign_step_metrics
// cascade-delete with the campaign row. contacts.campaign_id and
// lead_replies.campaign_id are ON DELETE SET NULL, so reply history
// and contact data survive the delete with just the campaign link
// detached.

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
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json(
      { error: "Owner role required" },
      { status: 403 },
    );
  }

  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, instantly_campaign_id, name")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | {
        id: string;
        organization_id: string;
        instantly_campaign_id: string | null;
        name: string;
      }
    | null;
  if (!c) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (c.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Instantly leg — only skip if the campaign has no remote id (shouldn't
  // happen in practice since campaigns are Instantly-sourced, but the
  // orphan-campaign flow could produce rows without an id).
  if (c.instantly_campaign_id) {
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
      await client.deleteCampaign(c.instantly_campaign_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[admin/campaigns/${campaignId}/delete] Instantly call failed:`,
        err,
      );
      return NextResponse.json(
        { error: `Instantly rejected the delete: ${message}` },
        { status: 502 },
      );
    }
  }

  const { error: deleteError } = await admin
    .from("campaigns")
    .delete()
    .eq("id", campaignId);
  if (deleteError) {
    console.error(
      `[admin/campaigns/${campaignId}/delete] Instantly deleted but local delete failed:`,
      deleteError,
    );
    return NextResponse.json(
      {
        warning:
          "Deleted on Instantly but local row remains. Next sync will drop the stale row.",
        error: deleteError.message,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({ success: true, deleted: c.name });
}
