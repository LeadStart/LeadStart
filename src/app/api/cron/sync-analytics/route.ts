import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";

export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel sends this automatically)
  if (process.env.CRON_SECRET && request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Optional: sync a specific campaign
  const campaignId = request.nextUrl.searchParams.get("campaign_id");

  // Get all organizations with API keys
  const { data: orgs } = await admin
    .from("organizations")
    .select("*")
    .not("instantly_api_key", "is", null);

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ error: "No organizations with API keys" }, { status: 400 });
  }

  let totalSynced = 0;

  for (const org of orgs) {
    const instantly = new InstantlyClient(org.instantly_api_key);

    // Get campaigns to sync
    let campaignsToSync;
    if (campaignId) {
      const { data } = await admin
        .from("campaigns")
        .select("*")
        .eq("id", campaignId)
        .eq("organization_id", org.id);
      campaignsToSync = data || [];
    } else {
      const { data } = await admin
        .from("campaigns")
        .select("*")
        .eq("organization_id", org.id)
        .eq("status", "active");
      campaignsToSync = data || [];
    }

    for (const campaign of campaignsToSync) {
      try {
        // Get the last snapshot date for this campaign
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

        // Fetch daily analytics from Instantly
        const analytics = await instantly.getDailyAnalytics(
          campaign.instantly_campaign_id,
          startDate,
          endDate
        );

        if (!analytics.data || analytics.data.length === 0) continue;

        // Upsert each day's data
        for (const day of analytics.data) {
          const sent = day.emails_sent || 0;
          const replies = day.replies || 0;
          const bounced = day.bounced || 0;
          const unsubs = day.unsubscribed || 0;

          await admin.from("campaign_snapshots").upsert(
            {
              campaign_id: campaign.id,
              snapshot_date: day.date,
              total_leads: day.new_leads_contacted || 0,
              emails_sent: sent,
              replies: replies,
              unique_replies: replies,
              positive_replies: 0, // Updated from webhook data
              bounces: bounced,
              unsubscribes: unsubs,
              meetings_booked: day.meetings_booked || 0,
              new_leads_contacted: day.new_leads_contacted || 0,
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
        console.error(`Failed to sync campaign ${campaign.id}:`, error);
      }
    }
  }

  return NextResponse.json({ synced: totalSynced });
}
