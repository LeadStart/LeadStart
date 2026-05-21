// POST /api/admin/contacts/push-to-campaign — bulk-assign contacts to a
// campaign and (for Salesforge) enqueue them for paced enrollment.
//
// Owner-only. Body: { contact_ids: string[], campaign_id: string }.
//
// Behavior:
// - Always updates contacts.campaign_id locally.
// - For Salesforge campaigns (source_channel='salesforge'): inserts rows
//   into salesforge_enrollment_queue with status='pending'. The hourly
//   cron at /api/cron/dispatch-salesforge-enrollments dequeues up to the
//   per-campaign daily cap and calls Salesforge's bulk-create + enroll.
//   We do NOT call Salesforge synchronously here — that was the old
//   behavior and it overflowed the 200 sends/day inbox capacity when an
//   owner pushed a large batch in one shot.
// - For LinkedIn campaigns: skips the push (LinkedIn enrollment is a
//   separate flow). The /campaigns/[id]/enroll route handles that.
//
// Returns counts + an estimated drain in days so the UI can show a
// meaningful toast.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SourceChannel } from "@/types/app";

// Same default used by the dispatcher when campaigns.salesforge_daily_contact_cap
// is NULL. Sized for a 3-step sequence against 200 sends/day of inbox capacity
// (8 inboxes × 25 sends/day): 200 / 3 ≈ 66 new contacts/day at steady state.
const DEFAULT_DAILY_CAP = 66;

interface PushBody {
  contact_ids?: string[];
  campaign_id?: string;
}

export async function POST(req: NextRequest) {
  let body: PushBody;
  try {
    body = (await req.json()) as PushBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactIds = Array.isArray(body.contact_ids)
    ? body.contact_ids.filter((v) => typeof v === "string" && v.length > 0)
    : [];
  const campaignId =
    typeof body.campaign_id === "string" && body.campaign_id.length > 0
      ? body.campaign_id
      : null;

  if (contactIds.length === 0) {
    return NextResponse.json(
      { error: "contact_ids is required" },
      { status: 400 },
    );
  }
  if (contactIds.length > 500) {
    return NextResponse.json(
      { error: "Maximum 500 contacts per request" },
      { status: 400 },
    );
  }
  if (!campaignId) {
    return NextResponse.json(
      { error: "campaign_id is required" },
      { status: 400 },
    );
  }

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

  const admin = createAdminClient();

  const { data: campaignData, error: campaignError } = await admin
    .from("campaigns")
    .select(
      "id, organization_id, source_channel, salesforge_sequence_id, salesforge_daily_contact_cap, name",
    )
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError) {
    console.error("[admin/contacts/push-to-campaign] campaign lookup failed:", campaignError);
    return NextResponse.json(
      { error: `Campaign lookup failed: ${campaignError.message}` },
      { status: 500 },
    );
  }
  const campaign = campaignData as
    | {
        id: string;
        organization_id: string;
        source_channel: SourceChannel;
        salesforge_sequence_id: string | null;
        salesforge_daily_contact_cap: number | null;
        name: string;
      }
    | null;
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaign.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: contactRows } = await admin
    .from("contacts")
    .select(
      "id, email, first_name, last_name, company_name, phone, title, linkedin_url",
    )
    .in("id", contactIds)
    .eq("organization_id", organizationId);
  const contacts = (contactRows ?? []) as {
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    phone: string | null;
    title: string | null;
    linkedin_url: string | null;
  }[];

  if (contacts.length === 0) {
    return NextResponse.json(
      { error: "No matching contacts in this organization" },
      { status: 400 },
    );
  }

  const skippedInvalid = contactIds.length - contacts.length;

  const { error: updateError } = await admin
    .from("contacts")
    .update({
      campaign_id: campaignId,
      updated_at: new Date().toISOString(),
    })
    .in(
      "id",
      contacts.map((c) => c.id),
    );
  if (updateError) {
    console.error("[admin/contacts/push-to-campaign] update failed:", updateError);
    return NextResponse.json(
      { error: "Could not assign contacts to campaign" },
      { status: 500 },
    );
  }

  // Email is required by Salesforge. Contacts without one are skipped
  // here rather than failing the whole batch.
  const pushable = contacts.filter(
    (c) => typeof c.email === "string" && c.email.trim().length > 0,
  );
  const skippedNoEmail = contacts.length - pushable.length;

  // ----- Per-channel branch -----

  if (campaign.source_channel === "salesforge") {
    if (!campaign.salesforge_sequence_id) {
      return NextResponse.json({
        assigned: contacts.length,
        queued: 0,
        already_queued: 0,
        skipped_no_email: 0,
        skipped_invalid: skippedInvalid,
        queued_to_dispatcher: false,
        reason: "Campaign has no Salesforge sequence id — cannot queue",
      });
    }

    // Fail fast on missing creds so the queue doesn't fill with rows
    // the dispatcher can never drain.
    const { data: orgData } = await admin
      .from("organizations")
      .select("id, salesforge_api_key, salesforge_workspace_id")
      .eq("id", organizationId)
      .maybeSingle();
    const org = orgData as
      | {
          id: string;
          salesforge_api_key: string | null;
          salesforge_workspace_id: string | null;
        }
      | null;

    if (!org?.salesforge_api_key) {
      return NextResponse.json(
        {
          error:
            "Salesforge API key not set. Save it in /admin/settings/api first.",
        },
        { status: 400 },
      );
    }
    if (!org?.salesforge_workspace_id) {
      return NextResponse.json(
        {
          error:
            "Salesforge workspace not selected. Open /admin/settings/api and pick one.",
        },
        { status: 400 },
      );
    }

    // Pre-filter: contacts that already have a pending queue row for
    // this campaign would hit the unique-index conflict and fail the
    // whole insert. Cheaper to filter than to per-row upsert.
    const pushableIds = pushable.map((c) => c.id);
    const { data: existingPending } = await admin
      .from("salesforge_enrollment_queue")
      .select("contact_id")
      .eq("campaign_id", campaignId)
      .eq("status", "pending")
      .in("contact_id", pushableIds);
    const alreadyPending = new Set(
      ((existingPending ?? []) as { contact_id: string }[]).map((r) => r.contact_id),
    );
    const toQueue = pushable.filter((c) => !alreadyPending.has(c.id));

    if (toQueue.length > 0) {
      const rows = toQueue.map((c) => ({
        organization_id: organizationId,
        campaign_id: campaignId,
        contact_id: c.id,
      }));
      const { error: insertError } = await admin
        .from("salesforge_enrollment_queue")
        .insert(rows);
      if (insertError) {
        console.error(
          "[admin/contacts/push-to-campaign] queue insert failed:",
          insertError,
        );
        return NextResponse.json(
          { error: `Queue insert failed: ${insertError.message}` },
          { status: 500 },
        );
      }
    }

    const cap = campaign.salesforge_daily_contact_cap ?? DEFAULT_DAILY_CAP;
    const drainDays = cap > 0 ? Math.ceil(toQueue.length / cap) : null;

    return NextResponse.json({
      assigned: contacts.length,
      queued: toQueue.length,
      already_queued: alreadyPending.size,
      skipped_no_email: skippedNoEmail,
      skipped_invalid: skippedInvalid,
      queued_to_dispatcher: true,
      provider: "salesforge",
      daily_cap: cap,
      estimated_drain_days: drainDays,
      campaign_name: campaign.name,
    });
  }

  // LinkedIn / other channels: contacts are assigned locally, but
  // upstream enrollment goes through /campaigns/[id]/enroll instead.
  return NextResponse.json({
    assigned: contacts.length,
    queued: 0,
    already_queued: 0,
    skipped_no_email: 0,
    skipped_invalid: skippedInvalid,
    queued_to_dispatcher: false,
    reason: `Push is not supported for ${campaign.source_channel} campaigns; use the channel-specific enrollment flow.`,
    campaign_name: campaign.name,
  });
}
