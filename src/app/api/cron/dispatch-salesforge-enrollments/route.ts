// GET /api/cron/dispatch-salesforge-enrollments
//
// Daily tick at 12:00 UTC (= 5am PDT / 4am PST — always ≤ 5am Pacific
// year-round, since Vercel cron doesn't track DST). Drains
// salesforge_enrollment_queue at a per-campaign daily cap so
// Salesforge.ai doesn't receive more new contacts per day than the
// connected inboxes can actually send to. Salesforge has no native
// equivalent for this cap — see migration 00050 for the motivation.
//
// Once-a-day is enough because Salesforge owns send-window pacing
// within the day. Our job is just to top the daily bucket up before
// the sender's workday starts.
//
// Per tick:
//   1. Group pending queue rows by campaign.
//   2. For each campaign, look up its cap (campaigns.salesforge_daily_contact_cap
//      or the DEFAULT_DAILY_CAP fallback) and count how many rows already
//      have status='sent' with processed_at::date = today (UTC). On the
//      normal schedule sent_today is 0; the count guards against manual
//      re-triggers double-enrolling.
//   3. Dequeue up to (cap - sent_today) oldest pending rows.
//   4. Call SalesforgeClient.pushContactsToSequence — the client itself
//      chunks into 100-row batches (Salesforge's bulk-create limit) and
//      enrolls everything into the sequence in one final PUT.
//   5. Mark each row 'sent' (success) or 'failed' (with the error). For
//      'sent' rows, also flip contacts.status to 'uploaded' so the
//      admin contacts table reflects reality.
//
// No per-row claim/lock — Vercel cron is at-most-once, and the rest of
// the codebase uses the same pattern (see run-linkedin-sequences).

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { SalesforgeClient } from "@/lib/salesforge/client";
import type { SalesforgeContactCreate } from "@/lib/salesforge/types";

export const maxDuration = 60;

// Same default the push endpoint uses when campaigns.salesforge_daily_contact_cap
// is NULL. 200 sends/day inbox capacity (8 inboxes × 25/day) ÷ 3-step
// sequence = ~66 new contacts/day at steady state.
const DEFAULT_DAILY_CAP = 66;

// Vercel budget is 60s. Each Salesforge bulk-create is ~1-2s and the
// final enroll PUT is ~500ms. 300 contacts → 3 chunks → ~5s per
// campaign. Multiple campaigns add up. Hard cap so a backlog can't
// blow the budget.
const MAX_CONTACTS_PER_TICK = 300;

type QueueRow = {
  id: string;
  organization_id: string;
  campaign_id: string;
  contact_id: string;
  created_at: string;
};

type CampaignRow = {
  id: string;
  organization_id: string;
  source_channel: string;
  status: string;
  salesforge_sequence_id: string | null;
  salesforge_daily_contact_cap: number | null;
  name: string;
};

type OrgRow = {
  id: string;
  salesforge_api_key: string | null;
  salesforge_workspace_id: string | null;
};

type ContactRow = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  phone: string | null;
  title: string | null;
  linkedin_url: string | null;
};

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  const { data: pendingData, error: pendingError } = await admin
    .from("salesforge_enrollment_queue")
    .select("id, organization_id, campaign_id, contact_id, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(MAX_CONTACTS_PER_TICK * 3);

  if (pendingError) {
    console.error(
      "[cron/dispatch-salesforge-enrollments] pending fetch failed:",
      pendingError,
    );
    return NextResponse.json({ error: pendingError.message }, { status: 500 });
  }

  const pending = (pendingData ?? []) as QueueRow[];
  if (pending.length === 0) {
    return NextResponse.json({ status: "idle" });
  }

  // Group pending rows by campaign so we can apply the per-campaign cap.
  const byCampaign = new Map<string, QueueRow[]>();
  for (const row of pending) {
    const list = byCampaign.get(row.campaign_id) ?? [];
    list.push(row);
    byCampaign.set(row.campaign_id, list);
  }

  // Bulk-fetch the campaigns + orgs referenced by this tick's queue.
  const campaignIds = [...byCampaign.keys()];
  const { data: campaignsData } = await admin
    .from("campaigns")
    .select(
      "id, organization_id, source_channel, status, salesforge_sequence_id, salesforge_daily_contact_cap, name",
    )
    .in("id", campaignIds);
  const campaignMap = new Map<string, CampaignRow>();
  for (const c of (campaignsData ?? []) as CampaignRow[]) {
    campaignMap.set(c.id, c);
  }

  const orgIds = [
    ...new Set(
      Array.from(campaignMap.values()).map((c) => c.organization_id),
    ),
  ];
  const { data: orgsData } = await admin
    .from("organizations")
    .select("id, salesforge_api_key, salesforge_workspace_id")
    .in("id", orgIds);
  const orgMap = new Map<string, OrgRow>();
  for (const o of (orgsData ?? []) as OrgRow[]) {
    orgMap.set(o.id, o);
  }

  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const startOfDayIso = startOfDayUtc.toISOString();

  let totalDispatched = 0;
  const results: Array<{
    campaign_id: string;
    queued: number;
    sent: number;
    failed: number;
    skipped_reason?: string;
  }> = [];

  for (const [campaignId, rows] of byCampaign) {
    if (totalDispatched >= MAX_CONTACTS_PER_TICK) {
      results.push({
        campaign_id: campaignId,
        queued: rows.length,
        sent: 0,
        failed: 0,
        skipped_reason: "per_tick_budget_exhausted",
      });
      continue;
    }

    const campaign = campaignMap.get(campaignId);
    if (!campaign) {
      // Campaign deleted but queue rows remain — drop them, the FK
      // cascade should have handled this but let's not loop on a
      // missing campaign.
      await admin
        .from("salesforge_enrollment_queue")
        .update({
          status: "failed",
          error: "Campaign no longer exists",
          processed_at: new Date().toISOString(),
        })
        .in(
          "id",
          rows.map((r) => r.id),
        );
      results.push({
        campaign_id: campaignId,
        queued: rows.length,
        sent: 0,
        failed: rows.length,
        skipped_reason: "campaign_missing",
      });
      continue;
    }

    if (campaign.source_channel !== "salesforge") {
      results.push({
        campaign_id: campaignId,
        queued: rows.length,
        sent: 0,
        failed: 0,
        skipped_reason: "wrong_channel",
      });
      continue;
    }

    if (campaign.status !== "active") {
      // Paused / archived. Leave rows pending — they'll dispatch when
      // the owner re-activates the campaign.
      results.push({
        campaign_id: campaignId,
        queued: rows.length,
        sent: 0,
        failed: 0,
        skipped_reason: `campaign_status_${campaign.status}`,
      });
      continue;
    }

    if (!campaign.salesforge_sequence_id) {
      await admin
        .from("salesforge_enrollment_queue")
        .update({
          status: "failed",
          error: "Campaign has no salesforge_sequence_id",
          processed_at: new Date().toISOString(),
        })
        .in(
          "id",
          rows.map((r) => r.id),
        );
      results.push({
        campaign_id: campaignId,
        queued: rows.length,
        sent: 0,
        failed: rows.length,
        skipped_reason: "no_sequence_id",
      });
      continue;
    }

    const org = orgMap.get(campaign.organization_id);
    if (!org?.salesforge_api_key || !org.salesforge_workspace_id) {
      // Leave rows pending — owner can fix creds and the next tick
      // will pick them up.
      results.push({
        campaign_id: campaignId,
        queued: rows.length,
        sent: 0,
        failed: 0,
        skipped_reason: "org_missing_credentials",
      });
      continue;
    }

    const cap = campaign.salesforge_daily_contact_cap ?? DEFAULT_DAILY_CAP;
    const { count: sentToday } = await admin
      .from("salesforge_enrollment_queue")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "sent")
      .gte("processed_at", startOfDayIso);

    const remaining = Math.max(0, cap - (sentToday ?? 0));
    if (remaining === 0) {
      results.push({
        campaign_id: campaignId,
        queued: rows.length,
        sent: 0,
        failed: 0,
        skipped_reason: "daily_cap_reached",
      });
      continue;
    }

    const tickBudgetRemaining = MAX_CONTACTS_PER_TICK - totalDispatched;
    const take = Math.min(remaining, tickBudgetRemaining, rows.length);
    const slice = rows.slice(0, take);

    // Fetch the contact details for this slice.
    const { data: contactsData } = await admin
      .from("contacts")
      .select(
        "id, email, first_name, last_name, company_name, phone, title, linkedin_url",
      )
      .in(
        "id",
        slice.map((r) => r.contact_id),
      );
    const contactMap = new Map<string, ContactRow>();
    for (const c of (contactsData ?? []) as ContactRow[]) {
      contactMap.set(c.id, c);
    }

    // Build the Salesforge payload. Rows whose contact got deleted or
    // has no email are immediately marked failed (with reason) and not
    // sent to Salesforge.
    const localFailed: Array<{ id: string; error: string }> = [];
    const pushable: Array<{ queueId: string; contact: ContactRow }> = [];
    for (const row of slice) {
      const contact = contactMap.get(row.contact_id);
      if (!contact) {
        localFailed.push({ id: row.id, error: "Contact no longer exists" });
        continue;
      }
      if (!contact.email || contact.email.trim().length === 0) {
        localFailed.push({ id: row.id, error: "Contact has no email" });
        continue;
      }
      pushable.push({ queueId: row.id, contact });
    }

    if (localFailed.length > 0) {
      const nowIso = new Date().toISOString();
      for (const f of localFailed) {
        await admin
          .from("salesforge_enrollment_queue")
          .update({ status: "failed", error: f.error, processed_at: nowIso })
          .eq("id", f.id);
      }
    }

    let sentCount = 0;
    let failedCount = localFailed.length;

    if (pushable.length > 0) {
      const sfContacts: SalesforgeContactCreate[] = pushable.map(({ contact }) => {
        const fallbackFirst = (contact.email ?? "").split("@")[0] || "Lead";
        return {
          firstName: contact.first_name?.trim() || fallbackFirst,
          email: contact.email!.trim(),
          lastName: contact.last_name ?? undefined,
          company: contact.company_name ?? undefined,
          position: contact.title ?? undefined,
          linkedinUrl: contact.linkedin_url ?? undefined,
        };
      });

      const client = new SalesforgeClient(org.salesforge_api_key);
      let pushResult: {
        uploaded: number;
        failed: { email: string | null; error: string }[];
      };
      try {
        pushResult = await client.pushContactsToSequence(
          org.salesforge_workspace_id,
          campaign.salesforge_sequence_id,
          sfContacts,
        );
      } catch (err) {
        // Fatal error on the entire pushable slice — mark every row
        // failed so the owner can see it. We don't auto-retry; the
        // owner re-queues by re-pushing the contacts.
        const errMsg = err instanceof Error ? err.message : String(err);
        const nowIso = new Date().toISOString();
        for (const p of pushable) {
          await admin
            .from("salesforge_enrollment_queue")
            .update({
              status: "failed",
              error: `pushContactsToSequence threw: ${errMsg}`,
              processed_at: nowIso,
            })
            .eq("id", p.queueId);
        }
        failedCount += pushable.length;
        results.push({
          campaign_id: campaignId,
          queued: rows.length,
          sent: 0,
          failed: failedCount,
          skipped_reason: "salesforge_push_threw",
        });
        continue;
      }

      // pushContactsToSequence returns per-email failures. Match back to
      // queue ids by email so we can mark each row correctly.
      const failedEmails = new Set(
        pushResult.failed
          .map((f) => f.email?.toLowerCase())
          .filter((e): e is string => Boolean(e)),
      );
      const failureReasonByEmail = new Map<string, string>();
      for (const f of pushResult.failed) {
        if (f.email) failureReasonByEmail.set(f.email.toLowerCase(), f.error);
      }
      const aggregateFailure = pushResult.failed.find((f) => !f.email);

      const sentIds: string[] = [];
      const sentContactIds: string[] = [];
      const failedRows: Array<{ id: string; error: string }> = [];
      const nowIso = new Date().toISOString();
      for (const p of pushable) {
        const email = p.contact.email!.trim().toLowerCase();
        if (failedEmails.has(email)) {
          failedRows.push({
            id: p.queueId,
            error: failureReasonByEmail.get(email) ?? "Salesforge rejected",
          });
        } else if (aggregateFailure) {
          // Sequence-enroll PUT failed after contacts were created.
          // Contacts exist in Salesforge but aren't in the sequence —
          // surface as failed so the owner can retry.
          failedRows.push({ id: p.queueId, error: aggregateFailure.error });
        } else {
          sentIds.push(p.queueId);
          sentContactIds.push(p.contact.id);
        }
      }

      if (sentIds.length > 0) {
        await admin
          .from("salesforge_enrollment_queue")
          .update({ status: "sent", error: null, processed_at: nowIso })
          .in("id", sentIds);
        await admin
          .from("contacts")
          .update({ status: "uploaded", updated_at: nowIso })
          .in("id", sentContactIds);
      }
      for (const f of failedRows) {
        await admin
          .from("salesforge_enrollment_queue")
          .update({ status: "failed", error: f.error, processed_at: nowIso })
          .eq("id", f.id);
      }

      sentCount = sentIds.length;
      failedCount += failedRows.length;
    }

    totalDispatched += sentCount;
    results.push({
      campaign_id: campaignId,
      queued: rows.length,
      sent: sentCount,
      failed: failedCount,
    });
  }

  return NextResponse.json({
    status: "ok",
    dispatched: totalDispatched,
    results,
  });
}
