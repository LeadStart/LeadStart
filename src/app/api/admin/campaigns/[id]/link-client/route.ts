// POST /api/admin/campaigns/[id]/link-client
//
// Owner-only. Attaches an orphan campaign (client_id IS NULL) to a
// LeadStart client. Accepts form-encoded body so the link-orphan form
// on /admin/campaigns/[id] can submit without JS.
//
// Body: client_id=<uuid>
// Success: 303 redirect back to the campaign detail page.

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

  const form = await req.formData();
  const clientId = form.get("client_id");
  if (typeof clientId !== "string" || clientId.length === 0) {
    return NextResponse.json(
      { error: "client_id is required" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Verify the campaign exists in this org.
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaign.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Verify the client is in the same org.
  const { data: client } = await admin
    .from("clients")
    .select("id, organization_id")
    .eq("id", clientId)
    .maybeSingle();
  if (!client || client.organization_id !== organizationId) {
    return NextResponse.json(
      { error: "Client not found in this organization" },
      { status: 400 },
    );
  }

  const { error: updateError } = await admin
    .from("campaigns")
    .update({ client_id: clientId, updated_at: new Date().toISOString() })
    .eq("id", campaignId);
  if (updateError) {
    return NextResponse.json(
      { error: `Update failed: ${updateError.message}` },
      { status: 500 },
    );
  }

  // 303 so the browser does a GET on the redirect target after the POST.
  const origin = req.nextUrl.origin;
  return NextResponse.redirect(
    new URL(`/app/admin/campaigns/${campaignId}`, origin),
    303,
  );
}
