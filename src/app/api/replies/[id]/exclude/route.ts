// POST /api/replies/[id]/exclude — include or exclude a reply from the
// client's statistics. Body: { excluded: boolean }.
//
// The native analytics roll-up (sync-analytics) skips excluded replies when it
// recomputes campaign_snapshots, so an excluded lead no longer counts toward
// replies / positive / meetings totals on the client dashboard + reports.
//
// Access mirrors the outcome route: the client_user who owns the reply, or any
// owner/VA in the reply's organization.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { LeadReply } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing reply id" }, { status: 400 });

  let body: { excluded?: boolean };
  try {
    body = (await req.json()) as { excluded?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.excluded !== "boolean") {
    return NextResponse.json({ error: "excluded (boolean) is required" }, { status: 400 });
  }
  const excluded = body.excluded;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: row, error: loadErr } = await admin
    .from("lead_replies")
    .select("id, organization_id, client_id")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Reply not found" }, { status: 404 });
  const reply = row as Pick<LeadReply, "id" | "organization_id" | "client_id">;

  const role = user.app_metadata?.role;
  const userOrgId = user.app_metadata?.organization_id;
  if (role === "owner" || role === "va") {
    if (reply.organization_id !== userOrgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    const { data: link } = await admin
      .from("client_users")
      .select("client_id")
      .eq("user_id", user.id)
      .eq("client_id", reply.client_id)
      .maybeSingle();
    if (!link) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error: updateErr } = await admin
    .from("lead_replies")
    .update({
      excluded_from_stats: excluded,
      excluded_at: excluded ? new Date().toISOString() : null,
      excluded_by: excluded ? user.id : null,
    })
    .eq("id", id);
  if (updateErr) {
    console.error("[replies/exclude] update failed:", updateErr);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }

  return NextResponse.json({ success: true, excluded });
}
