import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";

// Backfill email reply content from Instantly /emails API
// Pulls received emails for specified campaigns and updates webhook_events payload
// with subject, body, content_preview
//
// GET /api/backfill/emails?secret=<CRON_SECRET>

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // David's campaigns with interested leads
  const campaignIds = [
    "1888d1d8-d840-4871-b373-aa40c4a4dd8d",
    "8e3454ae-7e08-4eab-a1fb-302ef7e26616",
    "30ac2d58-6bea-4ea1-ac51-3d6fb54bfde1",
  ];

  // Get the org's API key
  const { data: orgs } = await admin
    .from("organizations")
    .select("*")
    .not("instantly_api_key", "is", null)
    .limit(1);

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ error: "No org with API key" }, { status: 400 });
  }

  const instantly = new InstantlyClient(orgs[0].instantly_api_key);
  let totalUpdated = 0;
  const errors: string[] = [];
  const campaignResults: { campaignId: string; emailsFetched: number; eventsUpdated: number }[] = [];

  for (const campaignId of campaignIds) {
    try {
      // Get received emails for this campaign
      const emails = await instantly.getAllEmails(campaignId, "received");

      // Build a map of lead email → most recent reply
      const replyMap = new Map<string, { subject: string; body: string; preview: string; from: string; timestamp: string; threadId: string }>();

      for (const email of emails) {
        // The lead is the sender for received emails
        const leadEmail = email.from_address_email?.toLowerCase();
        if (!leadEmail) continue;

        const existing = replyMap.get(leadEmail);
        // Keep the most recent reply, or first one if no existing
        if (!existing || new Date(email.timestamp_created) > new Date(existing.timestamp)) {
          // body can be { text, html } object or a string
          let bodyText = "";
          if (typeof email.body === "object" && email.body !== null) {
            const bodyObj = email.body as { html?: string; text?: string };
            bodyText = bodyObj.html || bodyObj.text || "";
          } else if (typeof email.body === "string") {
            bodyText = email.body;
          }
          replyMap.set(leadEmail, {
            subject: email.subject || "",
            body: bodyText,
            preview: email.content_preview || "",
            from: email.from_address_email,
            timestamp: email.timestamp_created,
            threadId: email.thread_id || "",
          });
        }
      }

      // Now update webhook_events that are email_replied for these leads
      let eventsUpdated = 0;

      // Get existing replied events for this campaign
      const { data: replyEvents } = await admin
        .from("webhook_events")
        .select("id, lead_email, payload")
        .eq("campaign_instantly_id", campaignId)
        .eq("event_type", "email_replied");

      if (replyEvents) {
        for (const event of replyEvents) {
          const leadEmail = event.lead_email?.toLowerCase();
          if (!leadEmail) continue;

          const replyData = replyMap.get(leadEmail);
          if (!replyData) continue;

          // Update the payload with email content
          const updatedPayload = {
            ...(event.payload as Record<string, unknown>),
            reply_subject: replyData.subject,
            reply_body: replyData.body,
            reply_preview: replyData.preview,
            reply_from: replyData.from,
            reply_timestamp: replyData.timestamp,
            reply_thread_id: replyData.threadId,
          };

          const { error } = await admin
            .from("webhook_events")
            .update({ payload: updatedPayload })
            .eq("id", event.id);

          if (error) {
            errors.push(`Update error for ${leadEmail}: ${error.message}`);
          } else {
            eventsUpdated++;
            totalUpdated++;
          }
        }
      }

      campaignResults.push({
        campaignId,
        emailsFetched: emails.length,
        eventsUpdated,
      });
    } catch (error) {
      errors.push(`Campaign ${campaignId}: ${(error as Error).message}`);
    }
  }

  return NextResponse.json({
    success: true,
    total_events_updated: totalUpdated,
    campaigns: campaignResults,
    errors: errors.length > 0 ? errors : undefined,
  });
}
