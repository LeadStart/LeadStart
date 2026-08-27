// GET /api/campaigns/[id]/candidate-contacts?q=&tag=&limit= — owner/va search
// over a campaign's CLIENT's existing CRM contacts, for pulling them into the
// campaign (Phase 2 of the contact-list ↔ campaign alignment). Returns each
// contact's standard fields + custom_fields (so the panel can validate variable
// coverage against the campaign registry) and whether it's already enrolled.
//
// Client-scoped: contacts belong to a client, and a native campaign sends to its
// own client's contacts — so a campaign with no client assigned has no candidates
// (the panel surfaces "assign a client first").

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

// Escape PostgREST filter metacharacters in user search text before it is
// interpolated into an `.or(...)` filter string (commas/parens are operators).
function sanitizeSearch(raw: string): string {
  return raw.replace(/[,()*\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id: campaignId } = await params;

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
  // No client → no client-scoped contacts to pull. Not an error; the panel shows
  // an "assign a client first" hint.
  if (!campaign.client_id) {
    return NextResponse.json({ candidates: [], client_assigned: false, limit: DEFAULT_LIMIT });
  }

  const url = new URL(req.url);
  const q = sanitizeSearch(url.searchParams.get("q") ?? "");
  const tag = (url.searchParams.get("tag") ?? "").trim().slice(0, 64);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT),
  );

  let query = admin
    .from("contacts")
    .select(
      "id, first_name, last_name, email, company_name, title, phone, tags, custom_fields, status",
    )
    .eq("organization_id", campaign.organization_id)
    .eq("client_id", campaign.client_id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (q) {
    // OR across the human-identifying columns. q is sanitized of filter metachars.
    query = query.or(
      `email.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,company_name.ilike.%${q}%`,
    );
  }
  if (tag) {
    query = query.contains("tags", [tag]);
  }

  const { data: rows, error } = await query;
  if (error) {
    console.error("[candidate-contacts] query failed:", error);
    return NextResponse.json({ error: "Could not load contacts" }, { status: 500 });
  }
  const contacts = (rows ?? []) as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    company_name: string | null;
    title: string | null;
    phone: string | null;
    tags: string[] | null;
    custom_fields: Record<string, unknown> | null;
    status: string;
  }[];

  // Mark which candidates are already enrolled in THIS campaign, so the panel can
  // badge them and exclude them from the "add" count.
  const enrolled = new Set<string>();
  if (contacts.length > 0) {
    const { data: enrollRows } = await admin
      .from("campaign_enrollments")
      .select("contact_id")
      .eq("campaign_id", campaignId)
      .in(
        "contact_id",
        contacts.map((c) => c.id),
      );
    for (const r of (enrollRows ?? []) as { contact_id: string }[]) {
      enrolled.add(r.contact_id);
    }
  }

  return NextResponse.json({
    client_assigned: true,
    limit,
    candidates: contacts.map((c) => ({
      id: c.id,
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      company_name: c.company_name,
      title: c.title,
      phone: c.phone,
      tags: Array.isArray(c.tags) ? c.tags : [],
      custom_fields:
        c.custom_fields && typeof c.custom_fields === "object" ? c.custom_fields : {},
      enrolled: enrolled.has(c.id),
    })),
  });
}
