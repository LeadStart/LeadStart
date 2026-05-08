// GET /api/admin/salesforge/custom-vars
//
// Returns the workspace's custom variables (used in step body
// templates as {{var_name}}). Owner-only.

import { NextResponse } from "next/server";
import {
  resolveSalesforgeOwnerContext,
  callSalesforge,
} from "@/lib/salesforge/route-helpers";

export async function GET() {
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;

  const result = await callSalesforge("listCustomVariables", () =>
    r.ctx.client.listCustomVariables(r.ctx.workspaceId),
  );
  if (!result.ok) return result.response;

  return NextResponse.json({ custom_vars: result.data });
}
