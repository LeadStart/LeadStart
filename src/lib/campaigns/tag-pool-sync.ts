// Live mailbox-tag binding reconciler (migration 00119).
//
// A campaign with campaigns.mailbox_tag set "follows" that tag: its
// campaign_mailboxes rotation pool is kept in sync with the inboxes currently
// carrying the tag, so adding an inbox to the tag automatically adds it to the
// campaign (Instantly-style), and removing it drops it from NEW first-touches.
// This is the piece the browser-only picker never did — there the tag was
// expanded to fixed IDs at pick time.
//
// Called from two places:
//   * the bind route (/api/admin/campaigns/[id]/mailbox-tag) — immediate sync
//     when the operator sets/refreshes the binding, and
//   * the reconcile-campaign-tags cron — every 5 min, to pick up inboxes added
//     to / removed from the tag afterward.
//
// The SEND PATH is untouched: run-native-sequences reads campaign_mailboxes
// verbatim. Auto-join works purely by keeping that table in sync here.
//
// Invariants honored:
//   * Dedicated-inbox policy — a tagged inbox already claimed by ANOTHER
//     non-completed campaign is skipped (reported in `skippedInUse`), never
//     double-attached.
//   * Never empty a live pool — if the tag currently resolves to zero eligible
//     inboxes, we DON'T strip the existing pool (a mis-tag or a mass re-claim
//     shouldn't silently halt a running campaign); `emptyGuard` flags it.
//   * Diff, not replace — we insert only the newly-tagged and delete only the
//     no-longer-tagged rows, so a concurrent send-cron tick never observes an
//     empty pool mid-write (same discipline as the manual PUT route).

import type { createAdminClient } from "@/lib/supabase/admin";
import { hasTag } from "@/lib/mailboxes/tags";
import { mailboxUsageMap } from "@/lib/campaigns/mailbox-usage";

type Admin = ReturnType<typeof createAdminClient>;

export interface TagPoolSyncResult {
  tag: string | null;
  /** A reconcile actually evaluated the pool (false when unbound). */
  synced: boolean;
  /** Resulting desired pool = tag members that could be attached to this campaign. */
  poolIds: string[];
  /** mailbox_ids newly inserted into campaign_mailboxes this run. */
  added: string[];
  /** mailbox_ids removed from campaign_mailboxes this run. */
  removed: string[];
  /** Tag members that belong to another campaign and so were NOT attached. */
  skippedInUse: { id: string; email: string; byCampaign: string }[];
  /** True when the tag resolved to zero eligible inboxes and we refused to
   *  strip a non-empty existing pool. */
  emptyGuard: boolean;
}

/**
 * Pure pool diff: given the DESIRED and CURRENT mailbox-id sets, what to insert
 * and what to delete. Extracted so the reconcile arithmetic is unit-testable
 * without a database (see scripts/test-tag-pool-sync.ts).
 */
export function computeTagPoolDiff(
  desired: string[],
  current: string[],
): { toAdd: string[]; toRemove: string[] } {
  const desiredSet = new Set(desired);
  const currentSet = new Set(current);
  return {
    toAdd: [...desiredSet].filter((id) => !currentSet.has(id)),
    toRemove: [...currentSet].filter((id) => !desiredSet.has(id)),
  };
}

/**
 * Reconcile one campaign's rotation pool against its bound tag. A no-op (returns
 * synced:false) when `tag` is null/blank — unbinding leaves the current pool
 * frozen as a manual snapshot for the operator to edit. Throws on a hard DB
 * error so the caller (route or cron) can surface / log it.
 */
export async function syncCampaignTagPool(
  admin: Admin,
  organizationId: string,
  campaignId: string,
  tag: string | null,
): Promise<TagPoolSyncResult> {
  const clean = (tag ?? "").trim();
  if (!clean) {
    return {
      tag: null,
      synced: false,
      poolIds: [],
      added: [],
      removed: [],
      skippedInUse: [],
      emptyGuard: false,
    };
  }

  // Inboxes in this org carrying the tag (case-insensitive) and sendable. The
  // fleet is small, so filter in JS the same way the picker groups tags.
  const { data: mbData, error: mbErr } = await admin
    .from("native_mailboxes")
    .select("id, email_address, status, tags")
    .eq("organization_id", organizationId);
  if (mbErr) throw new Error(mbErr.message);
  const members = ((mbData ?? []) as {
    id: string;
    email_address: string;
    status: string;
    tags: string[] | null;
  }[]).filter((m) => m.status === "active" && hasTag(m.tags ?? [], clean));

  // Dedicated-inbox policy: exclude tag members already owned by another
  // non-completed campaign (usageMap excludes THIS campaign, so members already
  // in our own pool are kept).
  const usage = await mailboxUsageMap(admin, organizationId, campaignId);
  const desired: string[] = [];
  const skippedInUse: TagPoolSyncResult["skippedInUse"] = [];
  for (const m of members) {
    const owner = usage.get(m.id);
    if (owner) {
      skippedInUse.push({ id: m.id, email: m.email_address, byCampaign: owner.campaignName });
    } else {
      desired.push(m.id);
    }
  }

  // Current pool.
  const { data: poolRows, error: poolErr } = await admin
    .from("campaign_mailboxes")
    .select("mailbox_id")
    .eq("campaign_id", campaignId);
  if (poolErr) throw new Error(poolErr.message);
  const current = ((poolRows ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id);

  // Guard: never strip a live pool down to empty because a tag momentarily
  // resolves to nothing (all members re-claimed, tag emptied, etc.).
  if (desired.length === 0) {
    return {
      tag: clean,
      synced: false,
      poolIds: current,
      added: [],
      removed: [],
      skippedInUse,
      emptyGuard: current.length > 0,
    };
  }

  const { toAdd, toRemove } = computeTagPoolDiff(desired, current);

  if (toAdd.length > 0) {
    const { error } = await admin
      .from("campaign_mailboxes")
      .insert(toAdd.map((mailbox_id) => ({ campaign_id: campaignId, mailbox_id })));
    if (error) throw new Error(error.message);
  }
  if (toRemove.length > 0) {
    const { error } = await admin
      .from("campaign_mailboxes")
      .delete()
      .eq("campaign_id", campaignId)
      .in("mailbox_id", toRemove);
    if (error) throw new Error(error.message);
  }

  return {
    tag: clean,
    synced: true,
    poolIds: desired,
    added: toAdd,
    removed: toRemove,
    skippedInUse,
    emptyGuard: false,
  };
}
