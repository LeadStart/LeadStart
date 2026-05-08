// /api/admin/salesforge/sequences/[id]/validation
//
// GET   — poll the current validation run's progress + results
// POST  — start a validation run (body { action: "start" | "skip" |
//         "confirm", esps?, statuses? })
//
// Salesforge's validation flow has 4 separate endpoints (start /
// result / confirm / skip). Collapsing them into one route here so the
// UI only needs to know one URL. Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveSalesforgeOwnerContext,
  callSalesforge,
} from "@/lib/salesforge/route-helpers";
import type {
  SalesforgeLeadESP,
  SalesforgeReonEmailStatus,
} from "@/lib/salesforge/types";

interface PostBody {
  action?: "start" | "skip" | "confirm";
  esps?: SalesforgeLeadESP[];
  statuses?: SalesforgeReonEmailStatus[];
}

async function resolveSeq(
  campaignId: string,
  organizationId: string,
): Promise<{ ok: true; sequenceId: string } | { ok: false; response: NextResponse }> {
  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel, salesforge_sequence_id")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | { id: string; organization_id: string; source_channel: string; salesforge_sequence_id: string | null }
    | null;
  if (!c) {
    return { ok: false, response: NextResponse.json({ error: "Campaign not found" }, { status: 404 }) };
  }
  if (c.organization_id !== organizationId) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (c.source_channel !== "salesforge" || !c.salesforge_sequence_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Campaign has no salesforge_sequence_id" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, sequenceId: c.salesforge_sequence_id };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;
  const seq = await resolveSeq(id, r.ctx.organizationId);
  if (!seq.ok) return seq.response;

  const result = await callSalesforge("getValidationResults", () =>
    r.ctx.client.getValidationResults(r.ctx.workspaceId, seq.sequenceId),
  );
  if (!result.ok) return result.response;
  return NextResponse.json(result.data);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;
  const seq = await resolveSeq(id, r.ctx.organizationId);
  if (!seq.ok) return seq.response;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = body.action ?? "start";

  if (action === "start") {
    const result = await callSalesforge("startSequenceValidation", () =>
      r.ctx.client.startSequenceValidation(r.ctx.workspaceId, seq.sequenceId),
    );
    if (!result.ok) return result.response;
    return NextResponse.json({ success: true });
  }

  if (action === "skip") {
    const result = await callSalesforge("skipSequenceValidation", () =>
      r.ctx.client.skipSequenceValidation(r.ctx.workspaceId, seq.sequenceId),
    );
    if (!result.ok) return result.response;
    return NextResponse.json({ success: true });
  }

  if (action === "confirm") {
    if (!Array.isArray(body.esps)) {
      return NextResponse.json(
        { error: "esps array is required for action=confirm" },
        { status: 400 },
      );
    }
    const result = await callSalesforge("confirmSequenceValidation", () =>
      r.ctx.client.confirmSequenceValidation(r.ctx.workspaceId, seq.sequenceId, {
        esps: body.esps!,
        statuses: body.statuses,
      }),
    );
    if (!result.ok) return result.response;
    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { error: `Unknown action: ${action}` },
    { status: 400 },
  );
}
