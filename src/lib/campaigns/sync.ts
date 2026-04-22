// Campaign metadata sync from Instantly → our campaigns table.
//
// Shared between the sync-analytics cron and the owner-triggered admin sync
// button. Runs per-organization:
//   - Fetches every campaign visible to the org's Instantly API key.
//   - For each one already in our DB: UPDATE name/status if they drifted.
//   - For each one NOT in our DB: INSERT with client_id = NULL ("orphan"),
//     name/status from Instantly. The owner links it to a LeadStart client
//     later via the B3 triage UI.
//
// Returns counts for the caller to surface (cron logs / admin toast).
//
// Invariant preserved: UNIQUE (organization_id, instantly_campaign_id) on
// campaigns means a race between two concurrent sync runs results in a
// duplicate-insert error on the loser, not two rows.

import type { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";

type AdminClient = ReturnType<typeof createAdminClient>;

export type SyncResult = {
  created: number;
  updated: number;
  orphan_count: number;
};

export async function syncCampaignMetadata(
  admin: AdminClient,
  org: { id: string; instantly_api_key: string | null },
): Promise<SyncResult> {
  if (!org.instantly_api_key) {
    throw new Error("Organization has no Instantly API key configured");
  }

  const instantly = new InstantlyClient(org.instantly_api_key);
  const instantlyCampaigns = await instantly.getAllCampaigns();

  const { data: dbCampaigns } = await admin
    .from("campaigns")
    .select("id, instantly_campaign_id, name, status")
    .eq("organization_id", org.id);

  const dbByInstantlyId = new Map(
    (dbCampaigns || []).map((c) => [c.instantly_campaign_id as string, c]),
  );

  let created = 0;
  let updated = 0;

  for (const ic of instantlyCampaigns) {
    const existing = dbByInstantlyId.get(ic.id);
    if (existing) {
      // Preserve whatever status the row already has on unrecognized values.
      const newStatus = mapInstantlyCampaignStatus(ic.status, existing.status);
      if (ic.name !== existing.name || newStatus !== existing.status) {
        const { error } = await admin
          .from("campaigns")
          .update({ name: ic.name, status: newStatus })
          .eq("id", existing.id);
        if (!error) updated++;
      }
    } else {
      // Brand-new orphan. Unrecognized status falls back to "draft" — never
      // default a fresh insert to "active", since active campaigns get pulled
      // into the snapshot-fetch loop and we don't want to pull analytics for
      // something the owner hasn't linked yet.
      const newStatus = mapInstantlyCampaignStatus(ic.status, "draft");
      const { error } = await admin.from("campaigns").insert({
        organization_id: org.id,
        instantly_campaign_id: ic.id,
        client_id: null,
        name: ic.name,
        status: newStatus,
      });
      if (!error) created++;
      // Duplicate-key errors from a concurrent sync are silently swallowed —
      // the row exists; we just didn't win the race to create it.
    }
  }

  const { count: orphanCount } = await admin
    .from("campaigns")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.id)
    .is("client_id", null);

  return { created, updated, orphan_count: orphanCount ?? 0 };
}

// Instantly encodes campaign status as a small integer. Keep the mapping in
// one place so cron/admin/webhook code can't drift.
export function mapInstantlyCampaignStatus(
  raw: number | undefined,
  fallback: string,
): string {
  switch (raw) {
    case 0:
      return "draft";
    case 1:
      return "active";
    case 2:
      return "paused";
    case 3:
      return "completed";
    default:
      return fallback;
  }
}
