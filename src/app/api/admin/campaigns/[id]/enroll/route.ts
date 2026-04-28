// POST /api/admin/campaigns/[id]/enroll — bulk-enroll contacts into a
// LinkedIn sequence. Owner-only. Inserts campaign_enrollments rows with
// status='active', current_step_index=0, last_action_at=null so the cron
// worker picks them up on the next tick.
//
// Idempotent: the (campaign_id, contact_id) UNIQUE constraint silently
// drops duplicates. The response reports how many rows were actually
// inserted vs. how many were already enrolled.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface EnrollBody {
  contact_ids?: string[];
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id: campaignId } = await params;

  let body: EnrollBody;
  try {
    body = (await req.json()) as EnrollBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactIds = Array.isArray(body.contact_ids)
    ? body.contact_ids.filter((v) => typeof v === "string" && v.length > 0)
    : [];
  if (contactIds.length === 0) {
    return NextResponse.json(
      { error: "contact_ids is required" },
      { status: 400 },
    );
  }
  if (contactIds.length > 500) {
    return NextResponse.json(
      { error: "Maximum 500 contacts per enroll request" },
      { status: 400 },
    );
  }

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

  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | { id: string; organization_id: string; source_channel: string }
    | null;
  if (!c) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (c.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (c.source_channel !== "linkedin") {
    return NextResponse.json(
      { error: "Enrollments are only supported for LinkedIn campaigns" },
      { status: 400 },
    );
  }

  // Verify the contacts belong to the same org so an owner can't enroll
  // contacts from a different tenant.
  const { data: validContacts } = await admin
    .from("contacts")
    .select("id")
    .in("id", contactIds)
    .eq("organization_id", c.organization_id);
  const validIds = new Set(
    ((validContacts as { id: string }[] | null) ?? []).map((r) => r.id),
  );
  const filtered = contactIds.filter((id) => validIds.has(id));

  if (filtered.length === 0) {
    return NextResponse.json(
      { error: "No matching contacts in this organization" },
      { status: 400 },
    );
  }

  const rows = filtered.map((contactId) => ({
    campaign_id: campaignId,
    contact_id: contactId,
    current_step_index: 0,
    status: "active" as const,
  }));

  const { data: inserted, error } = await admin
    .from("campaign_enrollments")
    .upsert(rows, {
      onConflict: "campaign_id,contact_id",
      ignoreDuplicates: true,
    })
    .select("id");

  if (error) {
    console.error("[admin/campaigns/enroll] upsert failed:", error);
    return NextResponse.json(
      { error: "Could not enroll contacts" },
      { status: 500 },
    );
  }

  const insertedCount = (inserted as { id: string }[] | null)?.length ?? 0;
  return NextResponse.json({
    enrolled: insertedCount,
    skipped_existing: filtered.length - insertedCount,
    skipped_invalid: contactIds.length - filtered.length,
  });
}
