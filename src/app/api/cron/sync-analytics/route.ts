import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { SalesforgeClient } from "@/lib/salesforge/client";

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // Optional: sync a specific campaign
  const campaignId = request.nextUrl.searchParams.get("campaign_id");

  const { data: orgs } = await admin
    .from("organizations")
    .select("*")
    .not("salesforge_api_key", "is", null);

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ error: "No organizations with Salesforge API keys" }, { status: 400 });
  }

  let totalSynced = 0;

  for (const org of orgs) {
    // Walk source_channel='salesforge' campaigns and refresh their
    // analytics. Salesforge legacy does not expose step-level metrics,
    // so campaign_step_metrics rows are not written for this channel.
    if (org.salesforge_api_key && org.salesforge_workspace_id) {
      const salesforge = new SalesforgeClient(org.salesforge_api_key);
      const salesforgeWorkspaceId = org.salesforge_workspace_id;

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
            salesforgeWorkspaceId,
            campaign.salesforge_sequence_id,
            startDate,
            endDate,
          );

          // Salesforge returns days as an object map keyed by date
          // (e.g. {"2026-05-07": {sent, replied, ...}}), not an array.
          const days = analytics.days ?? {};
          const dateKeys = Object.keys(days);
          if (dateKeys.length === 0) continue;

          for (const dateKey of dateKeys) {
            const day = days[dateKey];
            const sent = day.sent ?? 0;
            const replies = day.replied ?? 0;
            // Salesforge's day object doesn't expose bounces/unsubs/
            // meetings per-day on the legacy analytics surface — those
            // only show up in the rollup `stats`. Default to 0 for
            // per-day rows; the stats rollup is captured implicitly
            // by the most recent day's snapshot.

            await admin.from("campaign_snapshots").upsert(
              {
                campaign_id: campaign.id,
                snapshot_date: dateKey,
                total_leads: 0,
                emails_sent: sent,
                replies,
                unique_replies: replies,
                positive_replies: 0,
                bounces: 0,
                unsubscribes: 0,
                meetings_booked: 0,
                new_leads_contacted: 0,
                reply_rate: sent > 0 ? Number(((replies / sent) * 100).toFixed(2)) : 0,
                positive_reply_rate: 0,
                bounce_rate: 0,
                unsubscribe_rate: 0,
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
