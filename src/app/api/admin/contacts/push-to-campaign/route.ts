// POST /api/admin/contacts/push-to-campaign — bulk-assign contacts to a
// campaign and (for Instantly campaigns) push them to Instantly as leads.
//
// Owner-only. Body: { contact_ids: string[], campaign_id: string }.
//
// Behavior:
// - Always updates contacts.campaign_id locally.
// - For Instantly campaigns (source_channel='instantly') with a stored API
//   key: pushes each contact to Instantly via POST /leads, then sets
//   status='uploaded' on contacts that uploaded successfully.
// - For LinkedIn campaigns: skips the push (LinkedIn enrollment is a
//   separate flow). The /campaigns/[id]/enroll route handles that.
//
// Returns counts so the UI can show a meaningful toast.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";
import type { InstantlyLeadCreate } from "@/lib/instantly/types";

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

  const { data: campaignData } = await admin
    .from("campaigns")
    .select("id, organization_id, instantly_campaign_id, source_channel, name")
    .eq("id", campaignId)
    .maybeSingle();
  const campaign = campaignData as
    | {
        id: string;
        organization_id: string;
        instantly_campaign_id: string | null;
        source_channel: string | null;
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
    .select("id, email, first_name, last_name, company_name, phone")
    .in("id", contactIds)
    .eq("organization_id", organizationId);
  const contacts = (contactRows ?? []) as {
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    phone: string | null;
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

  const sourceChannel = campaign.source_channel ?? "instantly";

  if (sourceChannel !== "instantly") {
    return NextResponse.json({
      assigned: contacts.length,
      uploaded: 0,
      failed: 0,
      skipped_no_email: 0,
      skipped_invalid: skippedInvalid,
      pushed_to_instantly: false,
      reason: "LinkedIn campaign — no Instantly push",
    });
  }

  if (!campaign.instantly_campaign_id) {
    return NextResponse.json({
      assigned: contacts.length,
      uploaded: 0,
      failed: 0,
      skipped_no_email: 0,
      skipped_invalid: skippedInvalid,
      pushed_to_instantly: false,
      reason: "Campaign has no Instantly ID — cannot push",
    });
  }

  const { data: orgData } = await admin
    .from("organizations")
    .select("id, instantly_api_key")
    .eq("id", organizationId)
    .maybeSingle();
  const org = orgData as { id: string; instantly_api_key: string | null } | null;

  if (!org?.instantly_api_key) {
    return NextResponse.json(
      {
        error:
          "Instantly API key not set. Save it in /admin/settings/api first.",
      },
      { status: 400 },
    );
  }

  // Email is required by Instantly. Contacts without one are skipped here
  // rather than failing the whole batch.
  const pushable = contacts.filter(
    (c) => typeof c.email === "string" && c.email.trim().length > 0,
  );
  const skippedNoEmail = contacts.length - pushable.length;

  const leads: (Omit<InstantlyLeadCreate, "campaign"> & { _id: string })[] =
    pushable.map((c) => ({
      _id: c.id,
      email: c.email!.trim(),
      first_name: c.first_name ?? undefined,
      last_name: c.last_name ?? undefined,
      company_name: c.company_name ?? undefined,
      phone: c.phone ?? undefined,
    }));

  const client = new InstantlyClient(org.instantly_api_key);
  let uploaded = 0;
  const failed: { id: string; email: string; error: string }[] = [];
  const uploadedIds: string[] = [];

  for (const lead of leads) {
    try {
      const { _id, ...payload } = lead;
      await client.addLead({
        ...payload,
        campaign: campaign.instantly_campaign_id,
      });
      uploaded++;
      uploadedIds.push(_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ id: lead._id, email: lead.email, error: message });
    }
  }

  if (uploadedIds.length > 0) {
    const { error: statusError } = await admin
      .from("contacts")
      .update({ status: "uploaded", updated_at: new Date().toISOString() })
      .in("id", uploadedIds);
    if (statusError) {
      console.error(
        "[admin/contacts/push-to-campaign] status update failed:",
        statusError,
      );
    }
  }

  return NextResponse.json({
    assigned: contacts.length,
    uploaded,
    failed: failed.length,
    failures: failed,
    skipped_no_email: skippedNoEmail,
    skipped_invalid: skippedInvalid,
    pushed_to_instantly: true,
    campaign_name: campaign.name,
  });
}
