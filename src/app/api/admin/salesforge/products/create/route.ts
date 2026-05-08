// POST /api/admin/salesforge/products/create
//
// Creates a new product in the org's Salesforge workspace. A product
// is the marketing-offering envelope that sequences slot under.
// Body: SalesforgeProductRequest fields. Owner-only.

import { NextRequest, NextResponse } from "next/server";
import {
  resolveSalesforgeOwnerContext,
  callSalesforge,
} from "@/lib/salesforge/route-helpers";
import type { SalesforgeProductRequest } from "@/lib/salesforge/types";

export async function POST(req: NextRequest) {
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;

  let body: SalesforgeProductRequest;
  try {
    body = (await req.json()) as SalesforgeProductRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const result = await callSalesforge("createProduct", () =>
    r.ctx.client.createProduct(r.ctx.workspaceId, {
      product: {
        name: body.name.trim(),
        internalName: body.internalName?.trim(),
        language: body.language,
        industry: body.industry?.trim(),
        idealCustomerProfile: body.idealCustomerProfile?.trim(),
        pain: body.pain?.trim(),
        costOfInaction: body.costOfInaction?.trim(),
        solution: body.solution?.trim(),
        proofPoints: body.proofPoints?.trim(),
      },
    }),
  );
  if (!result.ok) return result.response;

  return NextResponse.json({ success: true, product: result.data });
}
