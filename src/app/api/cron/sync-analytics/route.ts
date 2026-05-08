import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { InstantlyClient } from "@/lib/instantly/client";
import { SalesforgeClient } from "@/lib/salesforge/client";
import { syncCampaignMetadata } from "@/lib/campaigns/sync";

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // Optional: sync a specific campaign
  const campaignId = request.nextUrl.searchParams.get("campaign_id");

  // Pull every org with at least one provider key configured. Per-org
  // we then branch by which keys are actually set.
  const { data: orgs } = await admin
    .from("organizations")
    .select("*")
    .or("instantly_api_key.not.is.null,salesforge_api_key.not.is.null");

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ error: "No organizations with API keys" }, { status: 400 });
  }

  let totalSynced = 0;

  for (const org of orgs) {
    // ===== INSTANTLY LEG =====
    if (org.instantly_api_key) {
      const instantly = new InstantlyClient(org.instantly_api_key);

      // Sync campaign metadata (names, statuses) from Instantly, and INSERT
      // any campaigns visible to Instantly that aren't in our DB yet as
      // orphans (client_id = NULL). See src/lib/campaigns/sync.ts.
      try {
        await syncCampaignMetadata(admin, org);
      } catch (metaErr) {
        console.error(`Failed to sync Instantly campaign metadata for org ${org.id}:`, metaErr);
      }

      let campaignsToSync;
      if (campaignId) {
        const { data } = await admin
          .from("campaigns")
          .select("*")
          .eq("id", campaignId)
          .eq("organization_id", org.id)
          .eq("source_channel", "instantly");
        campaignsToSync = data || [];
      } else {
        const { data } = await admin
          .from("campaigns")
          .select("*")
          .eq("organization_id", org.id)
          .eq("source_channel", "instantly")
          .eq("status", "active");
        campaignsToSync = data || [];
      }

      for (const campaign of campaignsToSync) {
        try {
          const { data: lastSnapshot } = await admin
            .from("campaign_snapshots")
            .select("snapshot_date")
            .eq("campaign_id", campaign.id)
            .order("snapshot_date", { ascending: false })
            .limit(1)
            .single();

          const startDate = lastSnapshot
            ? lastSnapshot.snapshot_date
            : new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
          const endDate = new Date().toISOString().split("T")[0];

          const analytics = await instantly.getDailyAnalytics(
            campaign.instantly_campaign_id,
            startDate,
            endDate
          );

          const days = Array.isArray(analytics) ? analytics : (analytics.data || []);
          if (days.length === 0) continue;

          // Note: Instantly daily API uses "sent" not "emails_sent",
          // "contacted" not "new_leads_contacted".
          for (const day of days) {
            const sent = (day as any).sent || day.emails_sent || 0;
            const replies = day.replies || 0;
            const uniqueReplies = (day as any).unique_replies || replies;
            const bounced = day.bounced || 0;
            const unsubs = day.unsubscribed || 0;
            const newLeads = day.new_leads_contacted || 0;
            const meetings = (day as any).opportunities || day.meetings_booked || 0;

            await admin.from("campaign_snapshots").upsert(
              {
                campaign_id: campaign.id,
                snapshot_date: day.date,
                total_leads: newLeads,
                emails_sent: sent,
                replies: replies,
                unique_replies: uniqueReplies,
                positive_replies: 0,
                bounces: bounced,
                unsubscribes: unsubs,
                meetings_booked: meetings,
                new_leads_contacted: newLeads,
                reply_rate: newLeads > 0 ? Number(((uniqueReplies / newLeads) * 100).toFixed(2)) : 0,
                positive_reply_rate: 0,
                bounce_rate: sent > 0 ? Number(((bounced / sent) * 100).toFixed(2)) : 0,
                unsubscribe_rate: sent > 0 ? Number(((unsubs / sent) * 100).toFixed(2)) : 0,
                raw_data: day as unknown as Record<string, unknown>,
              },
              { onConflict: "campaign_id,snapshot_date" }
            );
          }

          // ===== STEP-LEVEL ANALYTICS =====
          try {
            const stepData = await instantly.getStepAnalytics(
              campaign.instantly_campaign_id,
              startDate,
              endDate
            );

            const steps = Array.isArray(stepData) ? stepData : [];
            for (const step of steps) {
              if (step.step === null || step.step === undefined) continue;

              const replyRate = step.sent > 0
                ? Number(((step.unique_replies / step.sent) * 100).toFixed(2))
                : 0;
              const openRate = step.sent > 0
                ? Number(((step.unique_opened / step.sent) * 100).toFixed(2))
                : 0;
              const bounceRate = 0;

              await admin.from("campaign_step_metrics").upsert(
                {
                  campaign_id: campaign.id,
                  step: step.step,
                  period_start: startDate,
                  period_end: endDate,
                  sent: step.sent,
                  replies: step.replies,
                  unique_replies: step.unique_replies,
                  opens: step.opened,
                  unique_opens: step.unique_opened,
                  bounces: 0,
                  reply_rate: replyRate,
                  open_rate: openRate,
                  bounce_rate: bounceRate,
                },
                { onConflict: "campaign_id,step,period_start,period_end" }
              );
            }
          } catch (stepError) {
            console.error(`Failed to sync Instantly step analytics for campaign ${campaign.id}:`, stepError);
          }

          totalSynced++;
        } catch (error) {
          console.error(`Failed to sync Instantly campaign ${campaign.id}:`, error);
        }
      }
    }

    // ===== SALESFORGE LEG =====
    // Walk source_channel='salesforge' campaigns and refresh their
    // analytics. Salesforge legacy does not expose step-level metrics,
    // so step-level rows are dropped for this channel.
    if (org.salesforge_api_key) {
      const salesforge = new SalesforgeClient(org.salesforge_api_key);

      let salesforgeCampaigns;
      if (campaignId) {
        const { data } = await admin
          .from("campaigns")
          .select("*")
          .eq("id", campaignId)
          .eq("organization_id", org.id)
          .eq("source_channel", "salesforge");
        salesforgeCampaigns = data || [];
      } else {
        const { data } = await admin
          .from("campaigns")
          .select("*")
          .eq("organization_id", org.id)
          .eq("source_channel", "salesforge")
          .eq("status", "active");
        salesforgeCampaigns = data || [];
      }

      for (const campaign of salesforgeCampaigns) {
        if (!campaign.salesforge_sequence_id) continue;
        try {
          const { data: lastSnapshot } = await admin
            .from("campaign_snapshots")
            .select("snapshot_date")
            .eq("campaign_id", campaign.id)
            .order("snapshot_date", { ascending: false })
            .limit(1)
            .single();

          const startDate = lastSnapshot
            ? lastSnapshot.snapshot_date
            : new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
          const endDate = new Date().toISOString().split("T")[0];

          const analytics = await salesforge.getSequenceAnalytics(
            campaign.salesforge_sequence_id,
            startDate,
            endDate,
          );

          const days = analytics.daily ?? [];
          if (days.length === 0) continue;

          for (const day of days) {
            const sent = day.sent ?? 0;
            const replies = day.replied ?? 0;
            const bounced = day.bounced ?? 0;
            const unsubs = day.unsubscribed ?? 0;
            const meetings = day.meetings_booked ?? 0;

            await admin.from("campaign_snapshots").upsert(
              {
                campaign_id: campaign.id,
                snapshot_date: day.date,
                total_leads: 0,
                emails_sent: sent,
                replies,
                unique_replies: replies,
                positive_replies: 0,
                bounces: bounced,
                unsubscribes: unsubs,
                meetings_booked: meetings,
                new_leads_contacted: 0,
                reply_rate: sent > 0 ? Number(((replies / sent) * 100).toFixed(2)) : 0,
                positive_reply_rate: 0,
                bounce_rate: sent > 0 ? Number(((bounced / sent) * 100).toFixed(2)) : 0,
                unsubscribe_rate: sent > 0 ? Number(((unsubs / sent) * 100).toFixed(2)) : 0,
                raw_data: day as unknown as Record<string, unknown>,
              },
              { onConflict: "campaign_id,snapshot_date" }
            );
          }

          totalSynced++;
        } catch (error) {
          console.error(`Failed to sync Salesforge campaign ${campaign.id}:`, error);
        }
      }
    }
  }

  return NextResponse.json({ synced: totalSynced });
}
