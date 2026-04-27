import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/admin/prospecting/searches
//
// Returns the most recent ~20 searches for the caller's org for the
// "Recent searches" list on the Prospecting page. Strips the `results`
// JSONB so the list payload stays small — clicking a row hits the [id]
// endpoint to load the full results.

export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return NextResponse.json(
      { error: "Owner or VA role required" },
      { status: 403 },
    );
  }
  const organizationId = user.app_metadata?.organization_id as
    | string
    | undefined;
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
      "id, query, result_count, pages_fetched, truncated, status, started_at, completed_at, progress_message, error_message, target_max_results, created_at",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ searches: data ?? [] });
}
