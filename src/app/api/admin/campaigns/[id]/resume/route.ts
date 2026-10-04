// POST /api/admin/campaigns/[id]/resume: mark a paused campaign 'active'
// again so the cron workers pick it back up, or reopen a completed one.
// Owner or VA. A draft launches through /activate instead (lifecycle.ts).
//
// Reopening takes the campaign's inboxes back. Completing freed them, so another
// campaign may hold one by now, and an inbox belongs to one campaign at a time
// (mailbox-usage.ts): that refuses the reopen with a 409 naming the inboxes.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  reopenConflictMessage,
  reopenConflicts,
  transitionRefusal,
} from "@/lib/campaigns/lifecycle";
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
  // is enough to resume dispatching.
  if (
    c.source_channel !== "native_email" &&
    c.source_channel !== "linkedin"
  ) {
    return NextResponse.json(
      { error: `Resume is not supported for ${c.source_channel} campaigns yet.` },
      { status: 501 },
    );
  }

  const refusal = transitionRefusal("resume", c.status);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });
  const from = c.status as string;

  if (from === "completed") {
    const conflicts = await reopenConflicts(admin, c.organization_id, campaignId).catch(
      (err: unknown) => {
        console.error(`[admin/campaigns/${campaignId}/resume] inbox check failed:`, err);
        return null;
      },
    );
    if (conflicts === null) {
      return NextResponse.json(
        { error: "Couldn't check this campaign's inboxes. Try again." },
        { status: 500 },
      );
    }
    if (conflicts.length > 0) {
      return NextResponse.json(
        { error: reopenConflictMessage(conflicts), conflicts },
        { status: 409 },
      );
    }
  }

  // Compare-and-swap on the status just read, so a pause or complete landing in
  // between is never silently overwritten.
  const { data: updated, error: updateError } = await admin
    .from("campaigns")
    .update({ status: "active" })
    .eq("id", campaignId)
    .eq("status", from)
    .select("id");
  if (updateError) {
    console.error(
      `[admin/campaigns/${campaignId}/resume] status update failed:`,
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

  return NextResponse.json({ success: true, status: "active", reopened: from === "completed" });
}
