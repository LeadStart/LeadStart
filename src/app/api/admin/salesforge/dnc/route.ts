// POST /api/admin/salesforge/dnc
//
// Bulk-add email addresses to the workspace's do-not-contact list.
// Body: { dncs: string[] } — Salesforge dedupes server-side.
// Owner-only.

import { NextRequest, NextResponse } from "next/server";
import {
  resolveSalesforgeOwnerContext,
  callSalesforge,
} from "@/lib/salesforge/route-helpers";

interface DNCBody {
  dncs?: string[];
}

export async function POST(req: NextRequest) {
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;

  let body: DNCBody;
  try {
    body = (await req.json()) as DNCBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const dncs = Array.isArray(body.dncs)
    ? body.dncs
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0 && s.includes("@"))
    : [];
  if (dncs.length === 0) {
    return NextResponse.json(
      { error: "dncs array of email addresses is required" },
      { status: 400 },
    );
  }
  if (dncs.length > 1000) {
    return NextResponse.json(
      { error: "Maximum 1000 DNC entries per request" },
      { status: 400 },
    );
  }

  const result = await callSalesforge("bulkAddDNC", () =>
    r.ctx.client.bulkAddDNC(r.ctx.workspaceId, { dncs }),
  );
  if (!result.ok) return result.response;

  return NextResponse.json({ success: true, added: dncs.length });
}
