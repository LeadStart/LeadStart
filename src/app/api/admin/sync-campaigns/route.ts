// Owner-triggered "Sync from Instantly" — paired with the button on
// /admin/campaigns. Runs the same metadata sync the cron runs, but scoped
// to the caller's organization so the owner can see new campaigns in the DB
// immediately instead of waiting for the next cron tick.
//
// Returns { created, updated, orphan_count } so the UI can surface the
// result. Does NOT pull analytics snapshots — that's a heavier, cron-only
// job; this route is for "make the campaign row visible in LeadStart so I
// can link it to a client."

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncCampaignMetadata } from "@/lib/campaigns/sync";

export async function POST(_request: NextRequest) {
  const supabase = await createClient();
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
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: orgData, error: orgError } = await admin
    .from("organizations")
    .select("id, instantly_api_key")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgError || !orgData) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }
  const org = orgData as { id: string; instantly_api_key: string | null };

  if (!org.instantly_api_key) {
    return NextResponse.json(
      { error: "Instantly API key not set. Save it in the API settings first." },
      { status: 400 },
    );
  }

  try {
    const result = await syncCampaignMetadata(admin, org);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin/sync-campaigns] sync failed:", err);
    return NextResponse.json(
      { error: `Sync failed: ${message}` },
      { status: 502 },
    );
  }
}
