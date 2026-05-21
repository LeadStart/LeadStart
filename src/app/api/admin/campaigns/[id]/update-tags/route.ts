// POST /api/admin/campaigns/[id]/update-tags
//
// Owner-only. Updates campaigns.salesforge_default_tags. The
// dispatcher uses these tags on every contact it bulk-creates in
// Salesforge — Salesforge rejects untagged contacts (422) and tags
// drive segmentation on their side.
//
// Body: { tags: string[] | null }   // null or [] = clear, fall back to
//                                   // contact's own tags or "leadstart"

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

  let body: { tags?: string[] | null };
  try {
    body = (await req.json()) as { tags?: string[] | null };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Normalize: trim, drop empties. NULL or empty array = clear.
  const cleaned = Array.isArray(body.tags)
    ? body.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : null;
  const tagsToStore = cleaned && cleaned.length > 0 ? cleaned : null;

  const admin = createAdminClient();

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
      { error: "Tags only apply to Salesforge campaigns" },
      { status: 400 },
    );
  }

  const { error: updateError } = await admin
    .from("campaigns")
    .update({
      salesforge_default_tags: tagsToStore,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
  if (updateError) {
    return NextResponse.json(
      { error: `Update failed: ${updateError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, salesforge_default_tags: tagsToStore });
}
