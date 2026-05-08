// POST /api/admin/salesforge/inbox/reply
//
// Sends a reply directly through Salesforge from the admin inbox view,
// bypassing the lead_replies-keyed /api/replies/[id]/send route.
// Used when the admin wants to reply to a Salesforge thread that
// hasn't been ingested into our reply pipeline (or when we want to
// reply outside the classifier flow).
//
// Body: { mailbox_id: string, email_id: string, body_text: string,
//         body_html?: string, cc_addresses?: string[] }
// Owner-only.

import { NextRequest, NextResponse } from "next/server";
import {
  resolveSalesforgeOwnerContext,
  callSalesforge,
} from "@/lib/salesforge/route-helpers";

interface ReplyBody {
  mailbox_id?: string;
  email_id?: string;
  body_text?: string;
  body_html?: string;
  cc_addresses?: string[];
  bcc_addresses?: string[];
}

export async function POST(req: NextRequest) {
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;

  let body: ReplyBody;
  try {
    body = (await req.json()) as ReplyBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const mailboxId = body.mailbox_id?.trim();
  const emailId = body.email_id?.trim();
  const bodyText = body.body_text?.trim();
  if (!mailboxId || !emailId || !bodyText) {
    return NextResponse.json(
      { error: "mailbox_id, email_id, and body_text are required" },
      { status: 400 },
    );
  }

  const result = await callSalesforge("replyToEmail", () =>
    r.ctx.client.replyToEmail(r.ctx.workspaceId, mailboxId, emailId, {
      body_text: bodyText,
      body_html: body.body_html,
      cc_addresses: body.cc_addresses,
      bcc_addresses: body.bcc_addresses,
    }),
  );
  if (!result.ok) return result.response;

  return NextResponse.json({ success: true, sent: result.data });
}
