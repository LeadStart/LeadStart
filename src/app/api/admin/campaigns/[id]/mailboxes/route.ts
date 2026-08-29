// PUT /api/admin/campaigns/[id]/mailboxes — set the campaign's sending-mailbox
// rotation pool (campaign_mailboxes) to an exact set. Owner-only, org-scoped.
//
// Body: { mailbox_ids: string[] }  — the full desired pool. The route diffs
// against the current pool and only inserts the newly-selected / deletes the
// deselected rows, so a concurrent send-cron tick never sees an empty pool from
// a delete-all-then-reinsert. Unknown or cross-org ids are dropped rather than
// failing the request. Returns the resulting { mailbox_ids }.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PUT(
  req: NextRequest,
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
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  let body: { mailbox_ids?: unknown };
  try {
    body = (await req.json()) as { mailbox_ids?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.mailbox_ids)) {
    return NextResponse.json(
      { error: "mailbox_ids must be an array" },
      { status: 400 },
    );
  }
  const requested = [
    ...new Set(body.mailbox_ids.filter((v): v is string => typeof v === "string" && !!v)),
  ];

  const admin = createAdminClient();

  // Verify the campaign is in this org.
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id")
    .eq("id", campaignId)
    .maybeSingle();
  const camp = campaign as { id: string; organization_id: string } | null;
  if (!camp) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (camp.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Keep only mailboxes that actually belong to this org.
  let validIds: string[] = [];
  if (requested.length > 0) {
    const { data: mbRows } = await admin
      .from("native_mailboxes")
      .select("id")
      .in("id", requested)
      .eq("organization_id", organizationId);
    validIds = ((mbRows as { id: string }[] | null) ?? []).map((r) => r.id);
  }
  const desired = new Set(validIds);

  // Diff against the current pool.
  const { data: poolRows, error: poolError } = await admin
    .from("campaign_mailboxes")
    .select("mailbox_id")
    .eq("campaign_id", campaignId);
  if (poolError) {
    return NextResponse.json({ error: poolError.message }, { status: 500 });
  }
  const current = new Set(
    ((poolRows as { mailbox_id: string }[] | null) ?? []).map((r) => r.mailbox_id),
  );

  const toAdd = [...desired].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !desired.has(id));

  if (toAdd.length > 0) {
    const { error: insertError } = await admin
      .from("campaign_mailboxes")
      .insert(toAdd.map((mailbox_id) => ({ campaign_id: campaignId, mailbox_id })));
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }
  if (toRemove.length > 0) {
    const { error: deleteError } = await admin
      .from("campaign_mailboxes")
      .delete()
      .eq("campaign_id", campaignId)
      .in("mailbox_id", toRemove);
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ mailbox_ids: [...desired] });
}
