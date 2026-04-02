import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";

// One-time backfill: pull leads from Instantly and create webhook_events.
// Run one campaign at a time to avoid Vercel timeout:
//   GET /api/backfill/leads?campaign=<instantly_campaign_id>
// Or run all (will process first campaign only to avoid timeout):
//   GET /api/backfill/leads

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const targetCampaignId = request.nextUrl.searchParams.get("campaign");
  const admin = createAdminClient();

  // Get all organizations with API keys
  const { data: orgs } = await admin
    .from("organizations")
    .select("*")
    .not("instantly_api_key", "is", null);

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ error: "No organizations with API keys" }, { status: 400 });
  }

  let totalEvents = 0;
  let totalLeads = 0;
  const errors: string[] = [];
  const campaignSummaries: { name: string; leads: number; replied: number; meetings: number }[] = [];

  for (const org of orgs) {
    const instantly = new InstantlyClient(org.instantly_api_key);

    // Get campaigns to process
    let campaignQuery = admin
      .from("campaigns")
      .select("*")
      .eq("organization_id", org.id);

    if (targetCampaignId) {
      campaignQuery = campaignQuery.eq("instantly_campaign_id", targetCampaignId);
    }

    const { data: campaigns } = await campaignQuery;
    if (!campaigns) continue;

    for (const campaign of campaigns) {
      let campaignLeads = 0;
      let campaignReplied = 0;
      let campaignMeetings = 0;

      try {
        // Fetch ALL leads for this campaign (paginated)
        let cursor: string | undefined;

        do {
          const response = await instantly.listLeads(
            campaign.instantly_campaign_id,
            cursor
          );

          const leads = response.items || [];

          for (const lead of leads) {
            if (!lead.email) continue;
            campaignLeads++;

            const eventsToInsert: {
              organization_id: string;
              event_type: string;
              campaign_instantly_id: string;
              lead_email: string;
              payload: Record<string, unknown>;
              processed: boolean;
              received_at: string;
            }[] = [];

            // Create email_sent event for every lead
            eventsToInsert.push({
              organization_id: org.id,
              event_type: "email_sent",
              campaign_instantly_id: campaign.instantly_campaign_id,
              lead_email: lead.email,
              payload: {
                source: "backfill",
                first_name: lead.first_name,
                last_name: lead.last_name,
                company_name: lead.company_name,
              },
              processed: true,
              received_at: lead.timestamp_created,
            });

            // If lead has replies, create email_replied event
            if (lead.email_reply_count > 0) {
              campaignReplied++;
              eventsToInsert.push({
                organization_id: org.id,
                event_type: "email_replied",
                campaign_instantly_id: campaign.instantly_campaign_id,
                lead_email: lead.email,
                payload: {
                  source: "backfill",
                  reply_count: lead.email_reply_count,
                  lead_status: lead.status,
                  first_name: lead.first_name,
                  last_name: lead.last_name,
                  company_name: lead.company_name,
                },
                processed: true,
                // Use updated timestamp as approximate reply time
                received_at: lead.timestamp_updated,
              });
            }

            // Status 5 or specific lead_status indicates meeting/opportunity
            const leadStatus = (lead.lead_status || "").toLowerCase();
            if (
              lead.status === 5 ||
              leadStatus.includes("meeting") ||
              leadStatus.includes("opportunity") ||
              leadStatus.includes("closed")
            ) {
              campaignMeetings++;
              eventsToInsert.push({
                organization_id: org.id,
                event_type: "meeting_booked",
                campaign_instantly_id: campaign.instantly_campaign_id,
                lead_email: lead.email,
                payload: {
                  source: "backfill",
                  lead_status: lead.lead_status || String(lead.status),
                  first_name: lead.first_name,
                  last_name: lead.last_name,
                  company_name: lead.company_name,
                },
                processed: true,
                received_at: lead.timestamp_updated,
              });
            }

            if (eventsToInsert.length > 0) {
              const { error } = await admin
                .from("webhook_events")
                .insert(eventsToInsert);
              if (error) {
                errors.push(
                  `Insert error for ${lead.email} in ${campaign.name}: ${error.message}`
                );
              } else {
                totalEvents += eventsToInsert.length;
              }
            }
          }

          totalLeads += leads.length;
          cursor = response.next_starting_after;
        } while (cursor);

        campaignSummaries.push({
          name: campaign.name,
          leads: campaignLeads,
          replied: campaignReplied,
          meetings: campaignMeetings,
        });
      } catch (error) {
        const msg = `Failed to backfill campaign ${campaign.name}: ${(error as Error).message}`;
        console.error(msg);
        errors.push(msg);
      }
    }
  }

  return NextResponse.json({
    success: true,
    total_leads_processed: totalLeads,
    total_events_created: totalEvents,
    campaigns: campaignSummaries,
    errors: errors.length > 0 ? errors : undefined,
  });
}
