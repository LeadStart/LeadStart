// POST /api/campaigns/[id]/enroll-existing: pull EXISTING CRM contacts into a
// native email campaign (Phase 2 of the contact-list ↔ campaign alignment).
// Owner/VA only. Body: { contact_ids: string[] }.
//
// Mirrors the CSV import's tail for existing contacts: assigns the contacts to
// the campaign (contacts.campaign_id, so they show on the Leads tab) AND enrolls
// them for sending (campaign_enrollments upsert, onConflict ignoreDuplicates,
// re-adds nobody). Client-scoped: only the campaign's own client's contacts can
// be pulled in. No copy/registry mutation: CRM contacts fill existing variable
// VALUES; the panel warns where they don't (validation is client-side).

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface Body {
  contact_ids?: string[];
}

const MAX_PER_REQUEST = 500;
// A cached invalid/disposable verdict would be failed by the pre-send
// verification gate anyway: don't enroll those (mirrors the CSV + enroll routes).
const UNDELIVERABLE = new Set(["invalid", "disposable"]);

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id: campaignId } = await params;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const contactIds = Array.isArray(body.contact_ids)
    ? [...new Set(body.contact_ids.filter((v) => typeof v === "string" && v.length > 0))]
    : [];
  if (contactIds.length === 0) {
    return NextResponse.json({ error: "contact_ids is required" }, { status: 400 });
  }
  if (contactIds.length > MAX_PER_REQUEST) {
    return NextResponse.json(
      { error: `Maximum ${MAX_PER_REQUEST} contacts per request` },
      { status: 400 },
    );
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return NextResponse.json({ error: "Owner or VA role required" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: campaignRow } = await admin
    .from("campaigns")
    .select("id, organization_id, client_id, source_channel")
    .eq("id", campaignId)
    .maybeSingle();
  const campaign = campaignRow as
    | { id: string; organization_id: string; client_id: string | null; source_channel: string }
    | null;
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (campaign.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (campaign.source_channel !== "native_email") {
    return NextResponse.json(
      { error: "Pulling CRM contacts is only available for native email campaigns" },
      { status: 422 },
    );
  }
  if (!campaign.client_id) {
    return NextResponse.json(
      { error: "Assign a client to this campaign before adding contacts" },
      { status: 409 },
    );
  }

  // Client-scoped: only this campaign's client's contacts, and drop cached
  // undeliverables.
  const { data: validRows, error: valErr } = await admin
    .from("contacts")
    .select("id, email_verification_status")
    .in("id", contactIds)
    .eq("organization_id", campaign.organization_id)
    .eq("client_id", campaign.client_id);
  if (valErr) {
    console.error("[enroll-existing] contact validation failed:", valErr);
    return NextResponse.json({ error: "Could not load contacts" }, { status: 500 });
  }
  const rows = (validRows ?? []) as { id: string; email_verification_status: string | null }[];
  const eligible = rows
    .filter((r) => !UNDELIVERABLE.has(r.email_verification_status ?? ""))
    .map((r) => r.id);
  const skippedUndeliverable = rows.length - eligible.length;
  const skippedNotFound = contactIds.length - rows.length;

  if (eligible.length === 0) {
    return NextResponse.json(
      { error: "None of the selected contacts belong to this campaign's client" },
      { status: 400 },
    );
  }

  // Assign to the campaign (shows on the Leads tab; the dispatcher still works
  // off enrollments, below).
  const { error: assignErr } = await admin
    .from("contacts")
    .update({ campaign_id: campaignId, updated_at: new Date().toISOString() })
    .in("id", eligible);
  if (assignErr) {
    console.error("[enroll-existing] assign failed:", assignErr);
    return NextResponse.json({ error: "Could not assign contacts to the campaign" }, { status: 500 });
  }

  // Enroll for sending (idempotent via UNIQUE (campaign_id, contact_id)).
  const { data: enrolledRows, error: enrollErr } = await admin
    .from("campaign_enrollments")
    .upsert(
      eligible.map((contactId) => ({
        campaign_id: campaignId,
        contact_id: contactId,
        current_step_index: 0,
        status: "active" as const,
      })),
      { onConflict: "campaign_id,contact_id", ignoreDuplicates: true },
    )
    .select("id");
  if (enrollErr) {
    console.error("[enroll-existing] enrollment upsert failed:", enrollErr);
    return NextResponse.json(
      { error: "Contacts were assigned but could not be enrolled. Try again." },
      { status: 500 },
    );
  }
  const enrolled = ((enrolledRows as { id: string }[] | null) ?? []).length;

  return NextResponse.json({
    assigned: eligible.length,
    enrolled,
    already_enrolled: eligible.length - enrolled,
    skipped_undeliverable: skippedUndeliverable,
    skipped_not_in_client: skippedNotFound,
  });
}
