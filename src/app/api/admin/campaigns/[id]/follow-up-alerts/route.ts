// PUT /api/admin/campaigns/[id]/follow-up-alerts: switch the campaign's
// follow-up alerts on or off (campaigns.follow_up_alerts, migration 00142).
// On = every message a lead sends after their first reply pushes and emails the
// owner, whatever it says (src/lib/replies/follow-up.ts). Owner-only,
// org-scoped, like the saved reply.
//
// Body: { follow_up_alerts: boolean }.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return NextResponse.json({ error: "No organization on user" }, { status: 400 });

  let body: { follow_up_alerts?: unknown };
  try {
    body = (await req.json()) as { follow_up_alerts?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.follow_up_alerts !== "boolean") {
    return NextResponse.json({ error: "follow_up_alerts must be true or false" }, { status: 400 });
  }
  const on = body.follow_up_alerts;

  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id")
    .eq("id", campaignId)
    .maybeSingle();
  const camp = campaign as { id: string; organization_id: string } | null;
  if (!camp) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (camp.organization_id !== organizationId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { error } = await admin
    .from("campaigns")
    .update({ follow_up_alerts: on, updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("organization_id", organizationId);
  if (error) {
    const missingColumn = /follow_up_alerts/.test(error.message) && /column|schema cache/i.test(error.message);
    return NextResponse.json(
      { error: missingColumn ? "Follow-up alerts need database migration 00142, which isn't applied yet." : error.message },
      { status: missingColumn ? 409 : 500 },
    );
  }
  return NextResponse.json({ follow_up_alerts: on });
}
