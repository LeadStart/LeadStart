// POST /api/admin/campaigns/[id]/unlink-contact
//
// Owner-only. Unlinks a single contact from a campaign LeadStart-side
// (sets contacts.campaign_id = NULL). Does NOT call Salesforge — the
// legacy sequence API has no per-contact remove endpoint, so stopping
// Salesforge from sending requires either pausing the sequence in
// app.salesforge.ai or adding the email to the workspace DNC list.
//
// Side effect: also DELETEs the contact's pending salesforge_enrollment
// _queue row for this campaign (if any). Otherwise the dispatcher would
// still push them on its next run, even though they're no longer linked
// to the campaign — that's broken. "Unlink from campaign" implies
// "cancel pending enrollment too". 'sent' / 'failed' queue rows are
// historical and left alone.
//
// Body: { contact_id: string }
// Returns: { ok: true, contact_id, queue_row_removed: boolean }

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

  let body: { contact_id?: string };
  try {
    body = (await req.json()) as { contact_id?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const contactId = body.contact_id;
  if (typeof contactId !== "string" || contactId.length === 0) {
    return NextResponse.json(
      { error: "contact_id is required" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Verify the contact is in this org + linked to this campaign before
  // unlinking — prevents cross-org tampering and silent no-ops.
  const { data: contact } = await admin
    .from("contacts")
    .select("id, organization_id, campaign_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  if (contact.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (contact.campaign_id !== campaignId) {
    return NextResponse.json(
      { error: "Contact is not on this campaign" },
      { status: 400 },
    );
  }

  const { error: unlinkError } = await admin
    .from("contacts")
    .update({ campaign_id: null, updated_at: new Date().toISOString() })
    .eq("id", contactId);
  if (unlinkError) {
    return NextResponse.json(
      { error: `Unlink failed: ${unlinkError.message}` },
      { status: 500 },
    );
  }

  // Cancel any pending enrollment for this contact on this campaign.
  // The unlink-contact API is the per-row "Remove from campaign" action —
  // keeping the pending queue row alive would let the dispatcher push
  // a contact who's no longer on the campaign. Sent/failed rows are
  // historical and untouched.
  const { count: removedQueueCount } = await admin
    .from("salesforge_enrollment_queue")
    .delete({ count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("contact_id", contactId)
    .eq("status", "pending");

  return NextResponse.json({
    ok: true,
    contact_id: contactId,
    queue_row_removed: (removedQueueCount ?? 0) > 0,
  });
}
