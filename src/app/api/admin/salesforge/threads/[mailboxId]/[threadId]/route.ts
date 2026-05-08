// /api/admin/salesforge/threads/[mailboxId]/[threadId]
//
// GET — fetch the full thread (all messages + contact + sequence info)
// PUT — update the thread's primebox label. Body: { label_id: string }
//
// Owner-only.

import { NextRequest, NextResponse } from "next/server";
import {
  resolveSalesforgeOwnerContext,
  callSalesforge,
} from "@/lib/salesforge/route-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ mailboxId: string; threadId: string }> },
) {
  const { mailboxId, threadId } = await params;
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;

  const result = await callSalesforge("getThread", () =>
    r.ctx.client.getThread(r.ctx.workspaceId, mailboxId, threadId),
  );
  if (!result.ok) return result.response;

  return NextResponse.json({ thread: result.data });
}

interface LabelBody {
  label_id?: string;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ mailboxId: string; threadId: string }> },
) {
  const { mailboxId, threadId } = await params;
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;

  let body: LabelBody;
  try {
    body = (await req.json()) as LabelBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const labelId = body.label_id?.trim();
  if (!labelId) {
    return NextResponse.json({ error: "label_id is required" }, { status: 400 });
  }

  const result = await callSalesforge("updateThreadLabel", () =>
    r.ctx.client.updateThreadLabel(r.ctx.workspaceId, mailboxId, threadId, labelId),
  );
  if (!result.ok) return result.response;

  return NextResponse.json({ success: true });
}
