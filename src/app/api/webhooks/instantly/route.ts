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

  return NextResponse.json({ received: true });
}
