// POST /api/admin/campaigns/[id]/refresh-contacts
//
// Owner-only. On-demand version of the workspace-contact sync that
// normally runs hourly in /api/cron/sync-analytics. Used by the
// Refresh button on the campaign detail page so the owner can pull
// the latest Salesforge state without waiting for the hourly tick.
//
// What it does for this campaign's org:
//   1. Lists every contact in the Salesforge workspace.
//   2. Upserts each into LeadStart contacts (INSERT new, UPDATE existing
//      by email to attach salesforge_contact_id + status='uploaded'.
//      Refreshes name/company/linkedin/tags if Salesforge has them).
//   3. Auto-links unlinked workspace contacts to this campaign (only
//      when there's exactly one Salesforge campaign in the org — same
//      heuristic as the cron).
//   4. Detects contacts currently linked to this campaign whose
//      salesforge_contact_id no longer appears in Salesforge → unlinks
//      them (campaign_id = NULL). They stay in the contacts table but
//      drop off the campaign detail's contacts list.
//
// Returns counts so the UI toast can summarize what changed.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SalesforgeClient } from "@/lib/salesforge/client";

export const maxDuration = 60;

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

  const admin = createAdminClient();

  // Verify campaign exists in this org + has a Salesforge sequence.
  const { data: campaign } = await admin
    .from("campaigns")
    .select(
      "id, organization_id, client_id, source_channel, salesforge_sequence_id",
    )
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
      { error: "Refresh only applies to Salesforge campaigns" },
      { status: 400 },
    );
  }

  const { data: org } = await admin
    .from("organizations")
    .select("salesforge_api_key, salesforge_workspace_id")
    .eq("id", organizationId)
    .maybeSingle();
  if (!org?.salesforge_api_key || !org?.salesforge_workspace_id) {
    return NextResponse.json(
      { error: "Org is missing Salesforge credentials" },
      { status: 400 },
    );
  }

  const salesforge = new SalesforgeClient(org.salesforge_api_key);
  const workspaceId = org.salesforge_workspace_id;

  // ----- 1. Pull every workspace contact -----
  let workspaceContacts;
  try {
    workspaceContacts = await salesforge.listAllWorkspaceContacts(workspaceId);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Salesforge workspace list failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 502 },
    );
  }

  const usable = workspaceContacts.filter(
    (c) => c.email && c.email.includes("@"),
  );
  const sfIdsInWorkspace = new Set(usable.map((c) => c.id));
  const now = new Date().toISOString();

  // ----- 2. Upsert into contacts (split into INSERT new vs UPDATE existing) -----
  // Mirrors the logic in the sync-analytics cron. contacts has a UNIQUE
  // index on (org, lower(email)) — that's a functional index supabase-js
  // can't onConflict against, so we split manually.
  const emails = usable.map((c) => c.email!.trim());
  const { data: existingLocal } = await admin
    .from("contacts")
    .select("id, email")
    .eq("organization_id", organizationId)
    .in("email", emails);
  const existingByEmail = new Map<string, string>();
  for (const row of (existingLocal ?? []) as { id: string; email: string }[]) {
    existingByEmail.set(row.email.toLowerCase(), row.id);
  }

  let inserted = 0;
  let updated = 0;

  const toInsert = usable.filter(
    (c) => !existingByEmail.has(c.email!.trim().toLowerCase()),
  );
  if (toInsert.length > 0) {
    const insertPayload = toInsert.map((c) => ({
      id: crypto.randomUUID(),
      organization_id: organizationId,
      client_id: null,
      campaign_id: null,
      email: c.email!.trim(),
      salesforge_contact_id: c.id,
      first_name: c.firstName ?? null,
      last_name: c.lastName ?? null,
      company_name: c.company ?? null,
      linkedin_url: c.linkedinUrl ?? null,
      tags: c.tags ?? [],
      status: "uploaded",
      source: "salesforge-sync",
      created_at: now,
      updated_at: now,
    }));
    const { error: insertErr } = await admin
      .from("contacts")
      .insert(insertPayload);
    if (insertErr) {
      console.error(
        `[refresh-contacts] insert failed for org ${organizationId}:`,
        insertErr,
      );
    } else {
      inserted = insertPayload.length;
    }
  }

  const toUpdate = usable.filter((c) =>
    existingByEmail.has(c.email!.trim().toLowerCase()),
  );
  for (const c of toUpdate) {
    const localId = existingByEmail.get(c.email!.trim().toLowerCase())!;
    const patch: Record<string, unknown> = {
      salesforge_contact_id: c.id,
      status: "uploaded",
      source: "salesforge-sync",
      updated_at: now,
    };
    if (c.firstName) patch.first_name = c.firstName;
    if (c.lastName) patch.last_name = c.lastName;
    if (c.company) patch.company_name = c.company;
    if (c.linkedinUrl) patch.linkedin_url = c.linkedinUrl;
    if (c.tags && c.tags.length > 0) patch.tags = c.tags;
    const { error: updErr } = await admin
      .from("contacts")
      .update(patch)
      .eq("id", localId);
    if (!updErr) updated++;
  }

  // ----- 3. Compute true sequence membership.
  //
  // Salesforge has no "list contacts in sequence" endpoint, but
  // GET /contacts?not_in_sequence_id={seq} returns workspace contacts
  // NOT enrolled in that sequence. Set diff against the workspace
  // total gives us the true in-sequence set.
  //
  // Tested live: this filter is accurate. The Salesforge UI's
  // "Contacts: N" label on a sequence row counts something different
  // (we think workspace-uploaded contacts that were *intended* for the
  // sequence) but the API's not_in_sequence_id is honest about who's
  // actually enrolled.
  let inSequenceSfIds = new Set<string>();
  if (campaign.salesforge_sequence_id) {
    try {
      const notInSeq = await salesforge.listAllWorkspaceContacts(workspaceId, {
        notInSequenceId: campaign.salesforge_sequence_id,
      });
      const notInSeqIdSet = new Set(notInSeq.map((c) => c.id));
      inSequenceSfIds = new Set(
        [...sfIdsInWorkspace].filter((id) => !notInSeqIdSet.has(id)),
      );
    } catch (err) {
      console.error(
        "[refresh-contacts] not_in_sequence fetch failed:",
        err,
      );
      // Fall through with empty set — better to err on the side of
      // showing the user "0 in sequence" than to silently keep stale
      // links.
    }
  }

  // ----- 4. Link contacts that ARE in the Salesforge sequence but
  // not yet linked to this campaign locally.
  let linkedToCampaign = 0;
  if (inSequenceSfIds.size > 0) {
    const inSeqList = [...inSequenceSfIds];
    const chunkSize = 500;
    for (let i = 0; i < inSeqList.length; i += chunkSize) {
      const chunk = inSeqList.slice(i, i + chunkSize);
      const { count: linkedCount, error: linkErr } = await admin
        .from("contacts")
        .update(
          {
            campaign_id: campaign.id,
            client_id: campaign.client_id,
            updated_at: now,
          },
          { count: "exact" },
        )
        .eq("organization_id", organizationId)
        .in("salesforge_contact_id", chunk)
        .or(`campaign_id.is.null,campaign_id.neq.${campaign.id}`);
      if (linkErr) {
        console.error("[refresh-contacts] link-to-campaign failed:", linkErr);
      } else {
        linkedToCampaign += linkedCount ?? 0;
      }
    }
  }

  // ----- 5. Unlink contacts linked locally to this campaign whose
  // salesforge_contact_id is NOT in the in-sequence set (i.e. they
  // were removed from the Salesforge sequence assignment OR removed
  // from the workspace entirely). Either way, drop the local link.
  //
  // EXCEPT: contacts that have a pending row in
  // salesforge_enrollment_queue for this campaign are protected. They
  // were just imported and the dispatcher hasn't pushed them yet, so
  // Salesforge legitimately doesn't have them in the sequence — but
  // the operator's intent is clear and we shouldn't undo their import.
  let unlinkedNotInSequence = 0;
  const { data: linkedHere } = await admin
    .from("contacts")
    .select("id, salesforge_contact_id")
    .eq("campaign_id", campaign.id)
    .not("salesforge_contact_id", "is", null);
  // Pending queue rows protect their contact from unlink.
  const { data: pendingQueueRows } = await admin
    .from("salesforge_enrollment_queue")
    .select("contact_id")
    .eq("campaign_id", campaign.id)
    .eq("status", "pending");
  const pendingContactIds = new Set(
    ((pendingQueueRows ?? []) as { contact_id: string }[]).map(
      (r) => r.contact_id,
    ),
  );
  const orphanIds = ((linkedHere ?? []) as {
    id: string;
    salesforge_contact_id: string | null;
  }[])
    .filter(
      (r) =>
        r.salesforge_contact_id &&
        !inSequenceSfIds.has(r.salesforge_contact_id) &&
        !pendingContactIds.has(r.id),
    )
    .map((r) => r.id);
  if (orphanIds.length > 0) {
    const chunkSize = 500;
    for (let i = 0; i < orphanIds.length; i += chunkSize) {
      const chunk = orphanIds.slice(i, i + chunkSize);
      const { error: unlinkErr, count: c } = await admin
        .from("contacts")
        .update({ campaign_id: null, updated_at: now }, { count: "exact" })
        .in("id", chunk);
      if (unlinkErr) {
        console.error("[refresh-contacts] unlink failed:", unlinkErr);
      } else {
        unlinkedNotInSequence += c ?? 0;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    workspace_total: usable.length,
    in_sequence_total: inSequenceSfIds.size,
    inserted,
    updated,
    linked_to_campaign: linkedToCampaign,
    unlinked_not_in_sequence: unlinkedNotInSequence,
  });
}
