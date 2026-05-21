// POST /api/admin/campaigns/[id]/update-pacing
//
// Owner-only. Updates campaigns.salesforge_daily_contact_cap. NULL or
// 0 means "use the dispatcher default" (currently 66/day).
//
// Body: { daily_contact_cap: number | null }
// Returns: { ok: true, daily_contact_cap }

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json(
      { error: "No organization on user" },
      { status: 400 },
    );
  }

  let body: { daily_contact_cap?: number | null };
  try {
    body = (await req.json()) as { daily_contact_cap?: number | null };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw = body.daily_contact_cap;
  const cap =
    raw === null || raw === undefined
      ? null
      : typeof raw === "number" && Number.isFinite(raw) && raw > 0
        ? Math.floor(raw)
        : null;

  const admin = createAdminClient();

  // Scope check — same-org only.
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaign.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (campaign.source_channel !== "salesforge") {
    return NextResponse.json(
      { error: "Pacing cap only applies to Salesforge campaigns" },
      { status: 400 },
    );
  }

  const { error: updateError } = await admin
    .from("campaigns")
    .update({
      salesforge_daily_contact_cap: cap,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
  if (updateError) {
    return NextResponse.json(
      { error: `Update failed: ${updateError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, daily_contact_cap: cap });
}
