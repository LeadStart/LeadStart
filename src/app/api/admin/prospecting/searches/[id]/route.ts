import { NextRequest, NextResponse } from "next/server";
import { getForwardedIdentity } from "@/lib/security/identity";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/admin/prospecting/searches/[id]
// Polled by the Prospecting page to render live progress + final results.
// Returns the full prospect_searches row, scoped to the caller's org.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Identity from middleware-forwarded headers — no getUser() round-trip.
  // This route is polled every ~3s while a search runs, so the saved hop adds up.
  const identity = await getForwardedIdentity();
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "owner" && identity.role !== "va") {
    return NextResponse.json(
      { error: "Owner or VA role required" },
      { status: 403 },
    );
  }
  const organizationId = identity.organizationId;
  if (!organizationId) {
    return NextResponse.json(
      { error: "No organization on user" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("prospect_searches")
    .select(
      "id, organization_id, query, results, result_count, pages_fetched, truncated, saved_count, status, started_at, completed_at, progress_message, error_message, target_max_results, expires_at, created_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Search not found" }, { status: 404 });
  }
  const row = data as { organization_id: string };
  if (row.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ search: data });
}
