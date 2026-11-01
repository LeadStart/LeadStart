// The campaign bounce stop (owner pick 2026-11-01, migration 00140): when 3 of a
// campaign's last 100 first emails hard-bounce on a bad address, its new
// contacts pause by themselves (daily_new_leads_cap = 0, the Schedule tab's
// "Paused") and the owner gets an alert. Follow-ups keep going: those addresses
// already took an email.
//
// Why it exists: PolishPoint (c598d088) bounced 5 of its first 36 emails on
// launch day, 2026-10-26, and nothing in the app reacted. Inbox health scores
// bounces only once an inbox has sent 20 in 7 days, and the domain breaker is
// watch-only while domain_lifecycle_enabled is off. This stop counts per
// campaign from the first email, so it works in week one.
//
// What counts: a hard bounce on a FIRST email whose class says the address is
// bad (it doesn't exist, the mailbox is disabled or full, the domain or its
// mail tenant is gone). Spam and authentication refusals are a reputation
// problem and already alert on their own (mail_rejected_as_spam); a 5.7 policy
// refusal (e.g. "external forwarding not allowed") isn't about the list.
//
// Resuming: the stop counts only first emails sent after bounce_stop_at, so
// setting New contacts per day back to No limit starts a clean window instead
// of tripping again on the same bounces. bounce_stop_at can also be set by hand
// to restart the count on purpose (PolishPoint at go-live, owner pick
// 2026-11-01, after its list was cleaned); the Schedule tab's "paused by the
// bounce stop" note shows only when a campaign_bounce_stop alert went out then. Called by poll-native-replies after it
// marks a first email bounced. Test: scripts/test-bounce-stop.ts.

import type { createAdminClient } from "@/lib/supabase/admin";
import type { NativeBounceClass } from "@/types/app";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";

type Admin = ReturnType<typeof createAdminClient>;

/** How many of the campaign's most recent first emails the stop looks at. */
export const BOUNCE_STOP_WINDOW = 100;
/** Bad-address bounces within that window that pause new contacts. */
export const BOUNCE_STOP_LIMIT = 3;

export const BAD_ADDRESS_CLASSES: readonly NativeBounceClass[] = [
  "invalid_address",
  "mailbox_unavailable",
  "unreachable",
];

export interface FirstEmailRow {
  status: string;
  bounce_class: NativeBounceClass | null;
}

export function isBadAddressBounce(row: FirstEmailRow): boolean {
  return row.status === "bounced" && row.bounce_class != null && BAD_ADDRESS_CLASSES.includes(row.bounce_class);
}

/** The rule itself, on the campaign's most recent first emails (newest first). */
export function bounceStopVerdict(rows: readonly FirstEmailRow[]): { trip: boolean; bad: number; looked: number } {
  const window = rows.slice(0, BOUNCE_STOP_WINDOW);
  const bad = window.filter(isBadAddressBounce).length;
  return { trip: bad >= BOUNCE_STOP_LIMIT, bad, looked: window.length };
}

export type BounceStopOutcome =
  | { campaignId: string; action: "tripped"; bad: number; looked: number }
  | { campaignId: string; action: "under"; bad: number; looked: number }
  | { campaignId: string; action: "already_paused" | "not_found" | "error" };

/** Re-evaluate one campaign after a first email bounced. Idempotent: the pause
 *  is a guarded update, so two ticks can't both trip it or both alert. */
export async function evaluateBounceStop(admin: Admin, campaignId: string): Promise<BounceStopOutcome> {
  const { data: campRow, error: campErr } = await admin
    .from("campaigns")
    .select("id, name, status, daily_new_leads_cap, bounce_stop_at")
    .eq("id", campaignId)
    .maybeSingle();
  if (campErr) {
    console.error(`[bounce-stop] campaign ${campaignId} read failed:`, campErr.message);
    return { campaignId, action: "error" };
  }
  const camp = campRow as {
    id: string;
    name: string;
    status: string;
    daily_new_leads_cap: number | null;
    bounce_stop_at: string | null;
  } | null;
  if (!camp) return { campaignId, action: "not_found" };
  if (camp.daily_new_leads_cap === 0) return { campaignId, action: "already_paused" };

  let q = admin
    .from("native_sends")
    .select("status, bounce_class")
    .eq("campaign_id", campaignId)
    .eq("step_index", 0)
    .order("sent_at", { ascending: false })
    .limit(BOUNCE_STOP_WINDOW);
  if (camp.bounce_stop_at) q = q.gt("sent_at", camp.bounce_stop_at);
  const { data: rows, error: rowsErr } = await q;
  if (rowsErr) {
    console.error(`[bounce-stop] first-email read failed for ${campaignId}:`, rowsErr.message);
    return { campaignId, action: "error" };
  }
  const verdict = bounceStopVerdict((rows ?? []) as FirstEmailRow[]);
  if (!verdict.trip) return { campaignId, action: "under", bad: verdict.bad, looked: verdict.looked };

  const nowIso = new Date().toISOString();
  let upd = admin
    .from("campaigns")
    .update({ daily_new_leads_cap: 0, bounce_stop_at: nowIso, updated_at: nowIso })
    .eq("id", campaignId);
  upd = camp.daily_new_leads_cap == null ? upd.is("daily_new_leads_cap", null) : upd.eq("daily_new_leads_cap", camp.daily_new_leads_cap);
  const { data: updated, error: updErr } = await upd.select("id");
  if (updErr) {
    console.error(`[bounce-stop] pause failed for ${campaignId}:`, updErr.message);
    return { campaignId, action: "error" };
  }
  if ((updated ?? []).length === 0) return { campaignId, action: "already_paused" };

  const was = camp.daily_new_leads_cap == null ? "No limit" : `a limit of ${camp.daily_new_leads_cap} a day`;
  await enqueueOwnerAlert({
    admin,
    kind: "campaign_bounce_stop",
    subject: `New contacts paused on "${camp.name}": ${verdict.bad} bad-address bounces`,
    summary:
      `${verdict.bad} of the last ${verdict.looked} first emails on "${camp.name}" bounced on a bad address, ` +
      `so its new contacts are paused. Follow-ups keep going. Check the list before setting New contacts per day back (it was ${was}).`,
    context: {
      campaign_id: campaignId,
      campaign: camp.name,
      bad_address_bounces: verdict.bad,
      first_emails_counted: verdict.looked,
      new_contacts_per_day_before: was,
      where: "Campaign → Schedule → New contacts per day",
    },
  });
  return { campaignId, action: "tripped", bad: verdict.bad, looked: verdict.looked };
}
