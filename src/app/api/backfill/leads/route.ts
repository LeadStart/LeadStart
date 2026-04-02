import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";

// One-time backfill: pull all leads from Instantly and create webhook_events
// for leads that have replied, shown interest, or booked meetings.
// Run via: GET /api/backfill/leads?secret=<CRON_SECRET>

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
  const errors: string[] = [];

  for (const org of orgs) {
    const instantly = new InstantlyClient(org.instantly_api_key);

    // Get all campaigns for this org
    const { data: campaigns } = await admin
      .from("campaigns")
      .select("*")
      .eq("organization_id", org.id);

    if (!campaigns) continue;

    for (const campaign of campaigns) {
      try {
        // Fetch ALL leads for this campaign (paginated)
        let cursor: string | undefined;
        let leadCount = 0;

        do {
          const response = await instantly.listLeads(
            campaign.instantly_campaign_id,
            cursor
          );

          const leads = response.items || [];

          for (const lead of leads) {
            const events: { event_type: string; timestamp: string }[] = [];

            // Every lead was sent an email
            events.push({
              event_type: "email_sent",
              timestamp: lead.created_at,
            });

            // Check lead status for replies/interest/meetings
            const status = (lead.lead_status || lead.status || "").toLowerCase();

            if (
              status.includes("replied") ||
              status.includes("interested") ||
              status.includes("meeting") ||
              status.includes("closed") ||
              status.includes("out of office") ||
              status.includes("not interested") ||
              status.includes("do not contact") ||
              status === "1" // Instantly status 1 = replied
            ) {
              events.push({
                event_type: "email_replied",
                // Use created_at + 1 day as approximate reply time (we don't have exact reply time from leads endpoint)
                timestamp: new Date(
                  new Date(lead.created_at).getTime() + 86400000
                ).toISOString(),
              });
            }

            if (
              status.includes("meeting") ||
              status.includes("closed") ||
              status.includes("opportunity")
            ) {
              events.push({
                event_type: "meeting_booked",
                timestamp: new Date(
                  new Date(lead.created_at).getTime() + 2 * 86400000
                ).toISOString(),
              });
            }

            // Insert events (skip email_sent to avoid massive volume — only insert reply/meeting events)
            const eventsToInsert = events.map((e) => ({
              organization_id: org.id,
              event_type: e.event_type,
              campaign_instantly_id: campaign.instantly_campaign_id,
              lead_email: lead.email,
              payload: {
                source: "backfill",
                lead_status: lead.lead_status || lead.status,
                first_name: lead.first_name,
                last_name: lead.last_name,
                company_name: lead.company_name,
              },
              processed: true,
              received_at: e.timestamp,
            }));

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

            leadCount++;
          }

          cursor = response.next_starting_after;
        } while (cursor);

        console.log(
          `Backfilled ${leadCount} leads for campaign: ${campaign.name}`
        );
      } catch (error) {
        const msg = `Failed to backfill campaign ${campaign.name}: ${(error as Error).message}`;
        console.error(msg);
        errors.push(msg);
      }
    }
  }

  return NextResponse.json({
    success: true,
    total_events_created: totalEvents,
    errors: errors.length > 0 ? errors : undefined,
  });
}
