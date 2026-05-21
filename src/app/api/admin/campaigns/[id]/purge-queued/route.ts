// POST /api/admin/campaigns/[id]/purge-queued
//
// Owner-only. Bulk-deletes contacts on this campaign that are still
// "scheduled to be sent" — i.e. status='queued'.
//
// Source of truth: status='queued' is set by push-to-campaign and only
// flips to 'uploaded' when the dispatcher successfully enrolls the
// contact in Salesforge. So filtering on status='queued' alone correctly
// captures the "not yet pushed to this campaign's sequence" set.
//
// We intentionally do NOT also gate on `salesforge_contact_id IS NULL`:
// that column is populated by the hourly sync-analytics cron from any
// prior Salesforge workspace presence, and is independent of whether
// THIS campaign has dispatched the contact yet. Including the belt
// would silently exclude re-imported contacts (workspace-known but
// re-queued for a new campaign).
//
// Body (optional): { contact_ids?: string[] }
//   - omitted / null / non-array: delete ALL queued contacts on the campaign
//     (used by the "Clear queued" button on the queue card).
//   - empty array: no-op (returns deleted: 0).
//   - non-empty array: delete only those contact_ids that ALSO pass the
//     status='queued' gate (used by per-row bulk-select in the
//     contacts table). A client cannot escalate to delete uploaded
//     contacts by passing their ids — the status filter always applies.
//
// Cascade: salesforge_enrollment_queue.contact_id has ON DELETE CASCADE
// (migration 00050), so deleting the contacts also drops their queue
// rows. We do not need to touch the queue table directly.
//
// Returns: { ok: true, deleted: number }

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json(
      { error: "No organization on user" },
      { status: 400 },
    );
  }

  // Body is optional. A POST with no body (Content-Length: 0) is allowed
  // and means "delete all queued on this campaign" — used by the queue
  // card button.
  let contactIds: string[] | null = null;
  try {
    const text = await req.text();
    if (text.length > 0) {
      const body = JSON.parse(text) as { contact_ids?: unknown };
      if (Array.isArray(body.contact_ids)) {
        const filtered = body.contact_ids.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
        contactIds = filtered;
      }
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (contactIds !== null && contactIds.length === 0) {
    return NextResponse.json({ ok: true, deleted: 0 });
  }

  const admin = createAdminClient();

  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaign.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (campaign.source_channel !== "salesforge") {
    return NextResponse.json(
      { error: "Purge only applies to Salesforge campaigns" },
      { status: 400 },
    );
  }

  let query = admin
    .from("contacts")
    .delete()
    .eq("campaign_id", campaignId)
    .eq("organization_id", organizationId)
    .eq("status", "queued");

  if (contactIds !== null) {
    query = query.in("id", contactIds);
  }

  const { data: deleted, error: deleteError } = await query.select("id");

  if (deleteError) {
    return NextResponse.json(
      { error: `Purge failed: ${deleteError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, deleted: deleted?.length ?? 0 });
}
