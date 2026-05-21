// GET /api/admin/campaigns/[id]/salesforge-custom-vars
//
// Owner-only. Reads the Salesforge workspace's defined custom
// variables so the campaign-detail UI can show the operator what
// {{name}} placeholders they can reference in step copy.
//
// Scoped through the campaign id so the page only needs the
// campaign in scope (no separate workspace selector).

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SalesforgeClient } from "@/lib/salesforge/client";

export async function GET(
  _req: NextRequest,
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

  const { data: org } = await admin
    .from("organizations")
    .select("salesforge_api_key, salesforge_workspace_id")
    .eq("id", organizationId)
    .maybeSingle();
  if (!org?.salesforge_api_key || !org?.salesforge_workspace_id) {
    return NextResponse.json(
      { error: "Org is missing Salesforge credentials" },
      { status: 400 },
    );
  }

  try {
    const client = new SalesforgeClient(org.salesforge_api_key);
    const vars = await client.listCustomVariables(org.salesforge_workspace_id);
    return NextResponse.json({ ok: true, custom_vars: vars });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Salesforge custom-vars fetch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 502 },
    );
  }
}
