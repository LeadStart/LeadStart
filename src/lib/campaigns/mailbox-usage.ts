// Dedicated-inbox policy (one inbox → one campaign). A sending inbox may belong
// to at most one non-completed campaign's pool: while a campaign is a draft,
// active, or paused it "owns" its inboxes; a completed campaign frees them.
//
// This helper returns which of the org's inboxes are already claimed by ANOTHER
// campaign (optionally excluding the campaign being edited), mapped to the owning
// campaign so the UI can grey the row with an "in use" pill and the write paths
// can refuse to attach it. Shared by the campaign detail page, the mailboxes GET
// (for the new-campaign builder), and the attach/create routes so the picker and
// the server never disagree.

import type { createAdminClient } from "@/lib/supabase/admin";

export interface MailboxOwner {
  campaignId: string;
  campaignName: string;
}

/**
 * Map of mailbox_id → the OTHER non-completed campaign that already uses it.
 * `excludeCampaignId` omits the campaign currently being edited so its own
 * inboxes don't read as "in use".
 */
export async function mailboxUsageMap(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  excludeCampaignId?: string,
): Promise<Map<string, MailboxOwner>> {
  const { data: campRows } = await admin
    .from("campaigns")
    .select("id, name, status")
    .eq("organization_id", organizationId)
    .neq("status", "completed");

  const others = ((campRows ?? []) as { id: string; name: string; status: string }[]).filter(
    (c) => c.id !== excludeCampaignId,
  );
  const map = new Map<string, MailboxOwner>();
  if (others.length === 0) return map;

  const nameById = new Map(others.map((c) => [c.id, c.name]));
  const { data: cmRows } = await admin
    .from("campaign_mailboxes")
    .select("mailbox_id, campaign_id")
    .in(
      "campaign_id",
      others.map((c) => c.id),
    );

  for (const row of (cmRows ?? []) as { mailbox_id: string; campaign_id: string }[]) {
    if (!map.has(row.mailbox_id)) {
      map.set(row.mailbox_id, {
        campaignId: row.campaign_id,
        campaignName: nameById.get(row.campaign_id) ?? "another campaign",
      });
    }
  }
  return map;
}
