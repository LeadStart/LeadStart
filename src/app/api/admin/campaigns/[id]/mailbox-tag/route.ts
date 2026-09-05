// PUT /api/admin/campaigns/[id]/mailbox-tag: bind (or clear) the campaign's
// LIVE mailbox-tag (migration 00119). Owner-only, org-scoped.
//
// Body: { tag: string | null }
//   * a non-empty tag  → the campaign "follows" it: campaigns.mailbox_tag is set
//     and the rotation pool (campaign_mailboxes) is immediately reconciled to the
//     inboxes carrying that tag (dedicated-inbox policy honored; a live pool is
//     never emptied). Adding an inbox to the tag later auto-joins on the next
//     reconcile-campaign-tags cron tick.
//   * null / "" → unbind: the column is cleared and the current pool is LEFT as
//     a frozen manual snapshot for the operator to edit by hand.
//
// Returns the sync result ({ tag, added, removed, skippedInUse, emptyGuard, ... })
// so the UI can report exactly what happened.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeTag } from "@/lib/mailboxes/tags";
import { syncCampaignTagPool } from "@/lib/campaigns/tag-pool-sync";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  let body: { tag?: unknown };
  try {
    body = (await req.json()) as { tag?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const tag = normalizeTag(body.tag); // "" for null/blank/non-string

  const admin = createAdminClient();

  // Campaign must be in this org.
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id")
    .eq("id", campaignId)
    .maybeSingle();
  const camp = campaign as { id: string; organization_id: string } | null;
  if (!camp) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (camp.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Persist the binding (null clears it).
  const { error: updErr } = await admin
    .from("campaigns")
    .update({ mailbox_tag: tag || null })
    .eq("id", campaignId)
    .eq("organization_id", organizationId);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  // Reconcile now so the operator sees the effect immediately. A cleared binding
  // is a no-op sync (pool left frozen).
  try {
    const result = await syncCampaignTagPool(admin, organizationId, campaignId, tag || null);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Reconcile failed" },
      { status: 500 },
    );
  }
}
