// GET /api/buyer/prospecting/searches — the buyer's own Maps + LinkedIn searches
// (status + delivered), newest first, each annotated with its master-pool SEGMENT
// coverage ("you own N of ~M in this segment"). Served via the service-role client
// scoped to the buyer's org, so no per-table buyer RLS policy is needed.

import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { segmentForQuery } from "@/lib/tokens/segment";
import type { SearchKind } from "@/lib/tokens/pricing-math";

interface RawSearch {
  id: string;
  status: string;
  query: unknown;
  target_max_results: number | null;
  result_count: number | null;
  delivered_counts: Record<string, number> | null;
  cost_usd: number | null;
  created_at: string;
  completed_at: string | null;
}

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

  const rows: Array<RawSearch & { kind: SearchKind }> = [
    ...((maps.data as RawSearch[] | null) ?? []).map((r) => ({ ...r, kind: "maps" as const })),
    ...((linkedin.data as RawSearch[] | null) ?? []).map((r) => ({ ...r, kind: "linkedin" as const })),
  ];

  // Resolve each search's segment (pure) and batch-load its coverage: M (pool size
  // for the segment) from segment_pulls, N (this buyer's ownership) tallied from
  // contact_ownership. Both scoped to the segments actually on this page.
  const segByRow = rows.map((r) => segmentForQuery(r.kind, r.query));
  const keys = Array.from(new Set(segByRow.map((s) => s?.key).filter((k): k is string => Boolean(k))));

  const available = new Map<string, number>();
  const owned = new Map<string, number>();
  if (keys.length > 0) {
    const [sp, own] = await Promise.all([
      admin.from("segment_pulls").select("segment_key, master_contact_count").in("segment_key", keys),
      admin.from("contact_ownership").select("segment_key").eq("organization_id", organizationId).in("segment_key", keys),
    ]);
    for (const r of (sp.data as { segment_key: string; master_contact_count: number }[] | null) ?? []) {
      available.set(r.segment_key, Number(r.master_contact_count ?? 0));
    }
    for (const r of (own.data as { segment_key: string | null }[] | null) ?? []) {
      if (r.segment_key) owned.set(r.segment_key, (owned.get(r.segment_key) ?? 0) + 1);
    }
  }

  const annotated = rows.map((r, i) => {
    const seg = segByRow[i];
    const coverage = seg
      ? { owned: owned.get(seg.key) ?? 0, available: available.get(seg.key) ?? 0, terms: seg.terms, area: seg.area }
      : null;
    return { ...r, coverage };
  });

  return NextResponse.json({
    maps: annotated.filter((r) => r.kind === "maps"),
    linkedin: annotated.filter((r) => r.kind === "linkedin"),
  });
}
