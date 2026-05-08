// /api/admin/salesforge/sequences/[id]
//
// GET   — fetch full Salesforge sequence detail by LOCAL campaign id
//         (id is campaigns.id, not salesforge_sequence_id). Returns
//         steps, mailboxes, status, etc. Used by the edit-sequence page.
// PATCH — edit the sequence (any of: name, steps, mailboxes). The body
//         only includes the fields the user changed; absent fields are
//         left untouched.
//
// Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveSalesforgeOwnerContext,
  callSalesforge,
} from "@/lib/salesforge/route-helpers";
import type { SalesforgeStepRequest } from "@/lib/salesforge/types";

interface PatchBody {
  name?: string;
  steps?: Array<{
    id?: string;
    name?: string;
    wait_days?: number;
    subject?: string;
    body?: string;
  }>;
  mailbox_ids?: string[];
}

async function resolveSequenceId(
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
    | {
        id: string;
        organization_id: string;
        source_channel: string;
        salesforge_sequence_id: string | null;
      }
    | null;
  if (!c) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Campaign not found" }, { status: 404 }),
    };
  }
  if (c.organization_id !== organizationId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
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
  const seqRes = await resolveSequenceId(id, r.ctx.organizationId);
  if (!seqRes.ok) return seqRes.response;

  const result = await callSalesforge("getSequence", () =>
    r.ctx.client.getSequence(r.ctx.workspaceId, seqRes.sequenceId),
  );
  if (!result.ok) return result.response;

  return NextResponse.json({ sequence: result.data });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;
  const seqRes = await resolveSequenceId(id, r.ctx.organizationId);
  if (!seqRes.ok) return seqRes.response;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Steps update (optional).
  if (Array.isArray(body.steps)) {
    const steps: SalesforgeStepRequest[] = body.steps.map((step, idx) => ({
      id: step.id ?? "",
      name: step.name?.trim() || `Step ${idx + 1}`,
      order: idx,
      waitDays: typeof step.wait_days === "number" ? step.wait_days : (idx === 0 ? 0 : 3),
      variants: [
        {
          label: "A",
          emailSubject: step.subject?.trim() ?? "",
          emailContent: step.body?.trim() ?? "",
        },
      ],
    }));
    const stepsResult = await callSalesforge("updateSequenceSteps", () =>
      r.ctx.client.updateSequenceSteps(r.ctx.workspaceId, seqRes.sequenceId, steps),
    );
    if (!stepsResult.ok) return stepsResult.response;
  }

  // Mailbox assignment (optional).
  if (Array.isArray(body.mailbox_ids)) {
    const mbResult = await callSalesforge("assignSequenceMailboxes", () =>
      r.ctx.client.assignSequenceMailboxes(
        r.ctx.workspaceId,
        seqRes.sequenceId,
        body.mailbox_ids!,
      ),
    );
    if (!mbResult.ok) return mbResult.response;
  }

  // Local row name update (Salesforge has no /sequences/{id} PATCH for
  // name-only changes — the PUT /sequences/{id} on the spec is for the
  // full update which would also need other fields. Update locally.)
  if (typeof body.name === "string" && body.name.trim()) {
    const admin = createAdminClient();
    await admin
      .from("campaigns")
      .update({ name: body.name.trim() })
      .eq("id", id);
  }

  return NextResponse.json({ success: true });
}
