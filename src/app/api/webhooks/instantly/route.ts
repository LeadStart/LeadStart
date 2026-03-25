import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InstantlyWebhookPayload } from "@/lib/instantly/types";

export async function POST(request: NextRequest) {
  // Verify webhook secret (optional security via query param)
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  let payload: InstantlyWebhookPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Find the organization by matching the campaign
  let organizationId: string | null = null;
  if (payload.campaign_id) {
    const { data: campaign } = await admin
      .from("campaigns")
      .select("organization_id")
      .eq("instantly_campaign_id", payload.campaign_id)
      .limit(1)
      .single();

    organizationId = campaign?.organization_id || null;
  }

  // If we couldn't match, try the first org (single-org setup)
  if (!organizationId) {
    const { data: orgs } = await admin
      .from("organizations")
      .select("id")
      .limit(1);
    organizationId = orgs?.[0]?.id || null;
  }

  if (!organizationId) {
    return NextResponse.json({ error: "No organization found" }, { status: 400 });
  }

  // Store the event
  await admin.from("webhook_events").insert({
    organization_id: organizationId,
    event_type: payload.event_type,
    campaign_instantly_id: payload.campaign_id || null,
    lead_email: payload.lead_email || payload.email || null,
    payload: payload as unknown as Record<string, unknown>,
    processed: false,
  });

  // Track bounces per step (since the analytics API doesn't provide per-step bounces)
  if (payload.event_type === "email_bounced" && payload.campaign_id && payload.step) {
    const { data: campaign } = await admin
      .from("campaigns")
      .select("id")
      .eq("instantly_campaign_id", payload.campaign_id)
      .limit(1)
      .single();

    if (campaign) {
      const today = new Date().toISOString().split("T")[0];
      // Increment bounce count for this campaign + step + today's period
      const { data: existing } = await admin
        .from("campaign_step_metrics")
        .select("id, bounces, sent, bounce_rate")
        .eq("campaign_id", campaign.id)
        .eq("step", payload.step)
        .eq("period_start", today)
        .single();

      if (existing) {
        const newBounces = (existing.bounces || 0) + 1;
        const newBounceRate = existing.sent > 0
          ? Number(((newBounces / existing.sent) * 100).toFixed(2))
          : 0;
        await admin
          .from("campaign_step_metrics")
          .update({ bounces: newBounces, bounce_rate: newBounceRate })
          .eq("id", existing.id);
      }
    }
  }

  return NextResponse.json({ received: true });
}
