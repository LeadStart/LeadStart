// POST /api/admin/campaigns/[id]/update-custom-vars
//
// Owner-only. Updates campaigns.salesforge_custom_var_mapping.
//
// Body: { mapping: Record<string, string> | null }
//
// The mapping keys are Salesforge custom-variable names (whatever
// the operator's sequence step templates reference, e.g. {{intro}}).
// The values are LeadStart contact column names that the dispatcher
// reads to populate that variable per-contact, e.g. "intro_line".
// Example: { "intro": "intro_line", "notes": "notes" }
//
// Empty mapping ({} or null) = dispatcher sends no customVars.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// LeadStart contact columns the dispatcher knows how to read in
// resolveCustomVars(). Keep in sync with the ContactRow SELECT in
// /api/cron/dispatch-salesforge-enrollments/route.ts — adding a
// column to that SELECT lets it be referenced here as a mapping
// target.
const ALLOWED_MAPPING_TARGETS = new Set([
  "first_name",
  "last_name",
  "email",
  "company_name",
  "title",
  "phone",
  "linkedin_url",
  "intro_line",
  "notes",
]);

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

  let body: { mapping?: Record<string, string> | null };
  try {
    body = (await req.json()) as { mapping?: Record<string, string> | null };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate: every mapping value must be a known LeadStart contact
  // column. Spelling mistakes here would silently produce empty
  // customVars on every dispatch; better to reject up-front.
  let mappingToStore: Record<string, string> | null = null;
  if (body.mapping && typeof body.mapping === "object") {
    const cleaned: Record<string, string> = {};
    for (const [sfName, leadField] of Object.entries(body.mapping)) {
      if (typeof sfName !== "string" || sfName.trim().length === 0) continue;
      if (typeof leadField !== "string" || leadField.trim().length === 0) continue;
      if (!ALLOWED_MAPPING_TARGETS.has(leadField)) {
        return NextResponse.json(
          {
            error: `"${leadField}" is not a known LeadStart contact column. Allowed: ${Array.from(
              ALLOWED_MAPPING_TARGETS,
            ).join(", ")}`,
          },
          { status: 400 },
        );
      }
      cleaned[sfName.trim()] = leadField.trim();
    }
    mappingToStore = Object.keys(cleaned).length > 0 ? cleaned : null;
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
  if (campaign.source_channel !== "salesforge") {
    return NextResponse.json(
      { error: "Custom var mapping only applies to Salesforge campaigns" },
      { status: 400 },
    );
  }

  const { error: updateError } = await admin
    .from("campaigns")
    .update({
      salesforge_custom_var_mapping: mappingToStore,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
  if (updateError) {
    return NextResponse.json(
      { error: `Update failed: ${updateError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    salesforge_custom_var_mapping: mappingToStore,
  });
}
