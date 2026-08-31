// GET /api/buyer/prospecting/searches — the buyer's own Maps + LinkedIn searches
// (status + delivered), newest first. Served via the service-role client scoped
// to the buyer's org, so no per-table buyer RLS policy is needed.

import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "buyer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return NextResponse.json({ error: "No organization" }, { status: 400 });

  const admin = createAdminClient();
  const cols = "id, status, query, target_max_results, result_count, delivered_counts, cost_usd, created_at, completed_at";
  const [maps, linkedin] = await Promise.all([
    admin.from("maps_searches").select(cols).eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(20),
    admin.from("linkedin_searches").select(cols).eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(20),
  ]);

  return NextResponse.json({
    maps: (maps.data ?? []).map((r) => ({ ...r, kind: "maps" })),
    linkedin: (linkedin.data ?? []).map((r) => ({ ...r, kind: "linkedin" })),
  });
}
