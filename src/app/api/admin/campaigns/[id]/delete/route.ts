// POST /api/admin/campaigns/[id]/delete — delete the campaign from its
// upstream provider (Instantly or Salesforge) AND drop the local row.
// Owner only (matches the pattern for sync-campaigns, team management,
// client-user provisioning — anything irreversible or destructive).
// Requires the client to have already completed the typed-confirmation
// dialog on the UI; this route does NOT duplicate that check server-side
// (the confirm is a UX belt, not an auth mechanism).
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
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json(
      { error: "Owner role required" },
      { status: 403 },
    );
  }

  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select(
      "id, organization_id, source_channel, instantly_campaign_id, salesforge_sequence_id, name",
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
      }
    | null;
  if (!c) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (c.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Upstream leg — only skip if the campaign has no remote id (orphan
  // campaigns, or rows imported before a sync). Per-channel branch.
  const { data: org } = await admin
    .from("organizations")
    .select("instantly_api_key, salesforge_api_key, salesforge_workspace_id")
    .eq("id", c.organization_id)
    .maybeSingle();
  const orgRow = org as
    | {
        instantly_api_key: string | null;
        salesforge_api_key: string | null;
        salesforge_workspace_id: string | null;
      }
    | null;

  if (c.source_channel === "instantly" && c.instantly_campaign_id) {
    if (!orgRow?.instantly_api_key) {
      return NextResponse.json(
        { error: "Instantly API key not set on organization." },
        { status: 400 },
      );
    }
    try {
      const client = new InstantlyClient(orgRow.instantly_api_key);
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
  } else if (c.source_channel === "salesforge" && c.salesforge_sequence_id) {
    if (!orgRow?.salesforge_api_key) {
      return NextResponse.json(
        { error: "Salesforge API key not set on organization." },
        { status: 400 },
      );
    }
    if (!orgRow?.salesforge_workspace_id) {
      return NextResponse.json(
        { error: "Salesforge workspace not set on organization." },
        { status: 400 },
      );
    }
    try {
      const client = new SalesforgeClient(orgRow.salesforge_api_key);
      await client.deleteSequence(orgRow.salesforge_workspace_id, c.salesforge_sequence_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[admin/campaigns/${campaignId}/delete] Salesforge call failed:`,
        err,
      );
      return NextResponse.json(
        { error: `Salesforge rejected the delete: ${message}` },
        { status: 502 },
      );
    }
  }
  // Other channels (linkedin) or campaigns without an upstream id: skip
  // the upstream leg and just drop the local row.

  const { error: deleteError } = await admin
    .from("campaigns")
    .delete()
    .eq("id", campaignId);
  if (deleteError) {
    console.error(
      `[admin/campaigns/${campaignId}/delete] upstream deleted but local delete failed:`,
      deleteError,
    );
    return NextResponse.json(
      {
        warning:
          "Deleted upstream but local row remains. Next sync will drop the stale row.",
        error: deleteError.message,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({ success: true, deleted: c.name });
}
