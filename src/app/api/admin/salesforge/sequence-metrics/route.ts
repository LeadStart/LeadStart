// GET /api/admin/salesforge/sequence-metrics
//
// Returns workspace-wide rollup metrics across all (or filtered)
// sequences. Optional query params: product_id, sequence_ids[].
// Owner-only.

import { NextRequest, NextResponse } from "next/server";
import {
  resolveSalesforgeOwnerContext,
  callSalesforge,
} from "@/lib/salesforge/route-helpers";

export async function GET(req: NextRequest) {
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;

  const productId = req.nextUrl.searchParams.get("product_id") || undefined;
  const sequenceIds = req.nextUrl.searchParams.getAll("sequence_ids[]");

  const result = await callSalesforge("getWorkspaceSequenceMetrics", () =>
    r.ctx.client.getWorkspaceSequenceMetrics(r.ctx.workspaceId, {
      productId: productId,
      sequenceIds: sequenceIds.length > 0 ? sequenceIds : undefined,
    }),
  );
  if (!result.ok) return result.response;

  return NextResponse.json({ metrics: result.data });
}
