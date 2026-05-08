// POST /api/admin/contacts/push-to-campaign — bulk-assign contacts to a
// campaign and push them to the campaign's upstream provider (Instantly,
// Salesforge) as leads / contacts.
//
// Owner-only. Body: { contact_ids: string[], campaign_id: string }.
//
// Behavior:
// - Always updates contacts.campaign_id locally.
// - For Instantly campaigns (source_channel='instantly') with a stored API
//   key: pushes each contact to Instantly via POST /leads, then sets
//   status='uploaded' on contacts that uploaded successfully.
// - For Salesforge campaigns (source_channel='salesforge') with a stored
//   API key: pushes contacts in 100-row chunks via POST /contacts/bulk,
//   then enrolls all created contact ids into the sequence via
//   PUT /sequences/{id}/contacts.
// - For LinkedIn campaigns: skips the push (LinkedIn enrollment is a
//   separate flow). The /campaigns/[id]/enroll route handles that.
//
// Returns counts so the UI can show a meaningful toast.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";
import type { InstantlyLeadCreate } from "@/lib/instantly/types";
import { SalesforgeClient } from "@/lib/salesforge/client";
import type { SalesforgeContactCreate } from "@/lib/salesforge/types";
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
    .select(
      "id, organization_id, source_channel, instantly_campaign_id, salesforge_sequence_id, name",
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
        instantly_campaign_id: string | null;
        salesforge_sequence_id: string | null;
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

  // Email is required by both upstreams. Contacts without one are skipped
  // here rather than failing the whole batch.
  const pushable = contacts.filter(
    (c) => typeof c.email === "string" && c.email.trim().length > 0,
  );
  const skippedNoEmail = contacts.length - pushable.length;

  // ----- Per-channel branch -----

  if (campaign.source_channel === "instantly") {
    if (!campaign.instantly_campaign_id) {
      return NextResponse.json({
        assigned: contacts.length,
        uploaded: 0,
        failed: 0,
        skipped_no_email: 0,
        skipped_invalid: skippedInvalid,
        pushed: false,
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
      pushed: true,
      provider: "instantly",
      campaign_name: campaign.name,
    });
  }

  if (campaign.source_channel === "salesforge") {
    if (!campaign.salesforge_sequence_id) {
      return NextResponse.json({
        assigned: contacts.length,
        uploaded: 0,
        failed: 0,
        skipped_no_email: 0,
        skipped_invalid: skippedInvalid,
        pushed: false,
        reason: "Campaign has no Salesforge sequence id — cannot push",
      });
    }

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

    // Salesforge's CreateSimpleLeadRequest requires firstName. We fall
    // back to the local-part of the email when the contact row has no
    // first_name set (otherwise the bulk-create call would 422 the
    // entire chunk).
    const sfContacts: SalesforgeContactCreate[] = pushable.map((c) => {
      const fallbackFirst =
        (c.email ?? "").split("@")[0] || "Lead";
      return {
        firstName: c.first_name?.trim() || fallbackFirst,
        email: c.email!.trim(),
        lastName: c.last_name ?? undefined,
        company: c.company_name ?? undefined,
        position: c.title ?? undefined,
        linkedinUrl: c.linkedin_url ?? undefined,
      };
    });

    const client = new SalesforgeClient(org.salesforge_api_key);
    const result = await client.pushContactsToSequence(
      org.salesforge_workspace_id,
      campaign.salesforge_sequence_id,
      sfContacts,
    );

    // Salesforge's bulk endpoint doesn't tell us per-contact ids matched
    // back to our row ids, so we mark every contact whose email landed
    // in `pushable` and that wasn't in the failed list as 'uploaded'.
    const failedEmails = new Set(
      result.failed.map((f) => f.email?.toLowerCase()).filter(Boolean) as string[],
    );
    const uploadedIds = pushable
      .filter((c) => !failedEmails.has(c.email!.trim().toLowerCase()))
      .map((c) => c.id);

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
      uploaded: result.uploaded,
      failed: result.failed.length,
      failures: result.failed,
      skipped_no_email: skippedNoEmail,
      skipped_invalid: skippedInvalid,
      pushed: true,
      provider: "salesforge",
      campaign_name: campaign.name,
    });
  }

  // LinkedIn / other channels: contacts are assigned locally, but
  // upstream enrollment goes through /campaigns/[id]/enroll instead.
  return NextResponse.json({
    assigned: contacts.length,
    uploaded: 0,
    failed: 0,
    skipped_no_email: 0,
    skipped_invalid: skippedInvalid,
    pushed: false,
    reason: `Push is not supported for ${campaign.source_channel} campaigns; use the channel-specific enrollment flow.`,
    campaign_name: campaign.name,
  });
}
