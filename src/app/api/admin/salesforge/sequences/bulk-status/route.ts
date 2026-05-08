// POST /api/admin/salesforge/sequences/bulk-status
//
// Pause / resume multiple campaigns in one round-trip. Body:
//   { campaign_ids: string[], status: "active" | "paused" }
//
// Each campaign must be a Salesforge sequence in the caller's org;
// non-Salesforge or cross-org campaigns are reported in `failed[]`
// rather than silently skipped. Owner-only.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveSalesforgeOwnerContext } from "@/lib/salesforge/route-helpers";

interface BulkBody {
  campaign_ids?: string[];
  status?: "active" | "paused";
}

export async function POST(req: NextRequest) {
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;

  let body: BulkBody;
  try {
    body = (await req.json()) as BulkBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.campaign_ids)
    ? body.campaign_ids.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  const status = body.status;
  if (ids.length === 0) {
    return NextResponse.json({ error: "campaign_ids is required" }, { status: 400 });
  }
  if (status !== "active" && status !== "paused") {
    return NextResponse.json(
      { error: 'status must be "active" or "paused"' },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel, salesforge_sequence_id, name")
    .in("id", ids);
  const campaigns = (rows ?? []) as Array<{
    id: string;
    organization_id: string;
    source_channel: string;
    salesforge_sequence_id: string | null;
    name: string;
  }>;

  const failed: Array<{ id: string; error: string }> = [];
  const succeeded: string[] = [];

  for (const c of campaigns) {
    if (c.organization_id !== r.ctx.organizationId) {
      failed.push({ id: c.id, error: "wrong organization" });
      continue;
    }
    if (c.source_channel !== "salesforge" || !c.salesforge_sequence_id) {
      failed.push({ id: c.id, error: "not a salesforge sequence" });
      continue;
    }
    try {
      await r.ctx.client.updateSequenceStatus(
        r.ctx.workspaceId,
        c.salesforge_sequence_id,
        status,
      );
      await admin.from("campaigns").update({ status }).eq("id", c.id);
      succeeded.push(c.id);
    } catch (err) {
      failed.push({
        id: c.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Account for ids passed in that didn't match any row (deleted, etc.)
  const matchedIds = new Set(campaigns.map((c) => c.id));
  for (const id of ids) {
    if (!matchedIds.has(id)) {
      failed.push({ id, error: "not found" });
    }
  }

  return NextResponse.json({ succeeded, failed, status });
}
