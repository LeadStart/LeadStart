// POST /api/admin/campaigns/[id]/activate — flip a draft campaign to
// active. For the local channels (native email / LinkedIn) there is no
// upstream sequencer to start, so this is a local status change; the cron
// workers only dispatch campaigns with status='active'. Salesforge
// campaigns are managed in Salesforge and are not activated here.
// Owner or VA.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
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
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return NextResponse.json({ error: "Owner or VA role required" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel, status")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | { id: string; organization_id: string; source_channel: SourceChannel; status: string | null }
    | null;
  if (!c) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (c.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (c.source_channel !== "native_email" && c.source_channel !== "linkedin") {
    return NextResponse.json(
      { error: "Activate is only for native email and LinkedIn campaigns. Salesforge campaigns are managed in Salesforge." },
      { status: 400 },
    );
  }
  // Activate is strictly draft → active. 'completed' is terminal, and a
  // paused campaign is restarted via /resume, not here.
  if (c.status !== "draft") {
    return NextResponse.json(
      {
        error:
          c.status === "active"
            ? "Campaign is already active."
            : `Only draft campaigns can be activated (this one is ${c.status}${c.status === "paused" ? " — use Resume instead" : ""}).`,
      },
      { status: 400 },
    );
  }

  // Guard against activating a campaign that would just idle: native email
  // needs at least one mailbox in its pool and at least one step.
  if (c.source_channel === "native_email") {
    const [{ count: mailboxCount }, { count: stepCount }] = await Promise.all([
      admin.from("campaign_mailboxes").select("mailbox_id", { count: "exact", head: true }).eq("campaign_id", campaignId),
      admin.from("campaign_steps").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId),
    ]);
    if ((mailboxCount ?? 0) === 0) {
      return NextResponse.json(
        { error: "Add at least one sending mailbox to this campaign before activating." },
        { status: 400 },
      );
    }
    if ((stepCount ?? 0) === 0) {
      return NextResponse.json(
        { error: "This campaign has no steps to send." },
        { status: 400 },
      );
    }
  }

  const { error: updateError } = await admin
    .from("campaigns")
    .update({ status: "active" })
    .eq("id", campaignId);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, status: "active" });
}
