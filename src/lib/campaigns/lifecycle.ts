// Campaign lifecycle for the local channels (native email + LinkedIn): which
// status each action may start from, and the inbox checks that completing and
// reopening need. Shared by the pause / resume / complete routes and the
// complete/reopen dialog, so the controls and the server never disagree (the
// same idea as mailbox-usage.ts).
//
//   activate   draft           -> active     its own route (launch checks)
//   pause      active          -> paused
//   resume     paused          -> active
//   reopen     completed       -> active     the /resume route; refused while
//                                            another campaign holds one of its
//                                            inboxes
//   complete   active, paused  -> completed  stops sending, frees its inboxes
//
// Completing is the only way a campaign gives its inboxes back (mailbox-usage.ts
// counts every campaign that is not completed), and it is the owner's call:
// campaigns are refilled in waves (weekly CSVs, TuBe batches), so "nobody left
// mid-sequence" does not mean a campaign is done. Enrollments are left as they
// are on complete, so a reopen picks contacts up where they stopped.

import type { createAdminClient } from "@/lib/supabase/admin";
import { mailboxUsageMap } from "@/lib/campaigns/mailbox-usage";

type Admin = ReturnType<typeof createAdminClient>;

export type LifecycleAction = "pause" | "resume" | "complete";

/** The statuses each action may start from. */
export const LIFECYCLE_FROM: Record<LifecycleAction, readonly string[]> = {
  pause: ["active"],
  resume: ["paused", "completed"],
  complete: ["active", "paused"],
};

export function canTransition(
  action: LifecycleAction,
  status: string | null | undefined,
): boolean {
  return !!status && LIFECYCLE_FROM[action].includes(status);
}

/** Why `action` can't run from `status`, or null when it can. */
export function transitionRefusal(
  action: LifecycleAction,
  status: string | null | undefined,
): string | null {
  if (canTransition(action, status)) return null;
  const s = status ?? "unknown";
  if (action === "pause") {
    return s === "paused"
      ? "Campaign is already paused."
      : `Only active campaigns can be paused (this one is ${s}).`;
  }
  if (action === "resume") {
    if (s === "active") return "Campaign is already active.";
    if (s === "draft") return "This campaign hasn't launched. Use Launch campaign instead.";
    return `Only paused or completed campaigns can be resumed (this one is ${s}).`;
  }
  if (s === "completed") return "Campaign is already completed.";
  if (s === "draft") return "A draft has nothing to complete. Delete it instead.";
  return `Only active or paused campaigns can be completed (this one is ${s}).`;
}

export interface InboxConflict {
  mailboxId: string;
  email: string;
  /** The other campaign that now holds the inbox. */
  campaignName: string;
}

/** Refusal text for a reopen blocked by inboxes another campaign now holds. */
export function reopenConflictMessage(conflicts: InboxConflict[]): string {
  const one = conflicts.length === 1;
  const list = conflicts.map((c) => `${c.email} ("${c.campaignName}")`).join(", ");
  return (
    `Can't reopen yet. ${one ? "One of its inboxes is" : `${conflicts.length} of its inboxes are`} ` +
    `now used by another campaign: ${list}. An inbox can belong to one campaign at a time, so ` +
    `take ${one ? "it" : "them"} out of this campaign's inboxes (or off the other campaign) and reopen again.`
  );
}

export interface LifecycleSummary {
  /** The campaign's inbox pool: what completing frees and reopening takes back. */
  inboxes: { id: string; email: string }[];
  /** Contacts still mid-sequence (enrollments active or paused). */
  unfinished: number;
  /** Pool inboxes another non-completed campaign now holds; these block a reopen. */
  conflicts: InboxConflict[];
}

async function campaignPool(
  admin: Admin,
  campaignId: string,
): Promise<{ id: string; email: string }[]> {
  const { data: poolRows, error } = await admin
    .from("campaign_mailboxes")
    .select("mailbox_id")
    .eq("campaign_id", campaignId);
  if (error) throw new Error(error.message);
  const ids = ((poolRows ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id);
  if (ids.length === 0) return [];

  const { data: mbRows, error: mbError } = await admin
    .from("native_mailboxes")
    .select("id, email_address")
    .in("id", ids);
  if (mbError) throw new Error(mbError.message);
  const emailById = new Map(
    ((mbRows ?? []) as { id: string; email_address: string }[]).map((m) => [m.id, m.email_address]),
  );
  return ids.map((id) => ({ id, email: emailById.get(id) ?? id }));
}

async function conflictsIn(
  admin: Admin,
  organizationId: string,
  campaignId: string,
  pool: { id: string; email: string }[],
): Promise<InboxConflict[]> {
  if (pool.length === 0) return [];
  const usage = await mailboxUsageMap(admin, organizationId, campaignId);
  return pool
    .filter((m) => usage.has(m.id))
    .map((m) => ({ mailboxId: m.id, email: m.email, campaignName: usage.get(m.id)!.campaignName }));
}

/**
 * The campaign's own inboxes that ANOTHER non-completed campaign now holds.
 * Empty for a healthy active or paused campaign; for a completed one these are
 * inboxes handed on since it was completed, and they block a reopen.
 */
export async function reopenConflicts(
  admin: Admin,
  organizationId: string,
  campaignId: string,
): Promise<InboxConflict[]> {
  return conflictsIn(admin, organizationId, campaignId, await campaignPool(admin, campaignId));
}

/** What completing or reopening touches, for the confirm dialog. */
export async function lifecycleSummary(
  admin: Admin,
  organizationId: string,
  campaignId: string,
): Promise<LifecycleSummary> {
  const [inboxes, enrolled] = await Promise.all([
    campaignPool(admin, campaignId),
    admin
      .from("campaign_enrollments")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .in("status", ["active", "paused"]),
  ]);
  if (enrolled.error) throw new Error(enrolled.error.message);
  return {
    inboxes,
    unfinished: enrolled.count ?? 0,
    conflicts: await conflictsIn(admin, organizationId, campaignId, inboxes),
  };
}
