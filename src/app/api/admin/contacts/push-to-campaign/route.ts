// POST /api/admin/contacts/push-to-campaign — bulk-assign contacts to a
// campaign by setting contacts.campaign_id locally.
//
// Owner-only. Body: { contact_ids: string[], campaign_id: string }.
//
// This does the local assignment only. Channel-specific enrollment (native
// email sequence enrollment, LinkedIn) is handled by the channel's own
// enrollment flow, not here.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SourceChannel } from "@/types/app";

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
    .select("id, organization_id, source_channel, name")
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

  // Contacts are assigned locally here; upstream enrollment (native email
  // sequence enrollment, LinkedIn) goes through the channel's own flow.
  return NextResponse.json({
    assigned: contacts.length,
    queued: 0,
    already_queued: 0,
    skipped_no_email: 0,
    skipped_invalid: skippedInvalid,
    queued_to_dispatcher: false,
    campaign_name: campaign.name,
  });
}
