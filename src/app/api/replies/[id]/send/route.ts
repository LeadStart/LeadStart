// POST /api/replies/[id]/send — send the client's edited reply through
// Salesforge and CC the client's notification email so the thread lives
// in their inbox.
//
// Flow:
//   1. Auth + access check (client_users or admin/VA in the org).
//   2. Precondition check: salesforge_mailbox_id + salesforge_email_id +
//      org-level salesforge_workspace_id.
//   3. Atomic load+claim: UPDATE status='sent' WHERE id=:id AND status IN
//      ('new','classified') RETURNING *. Guards against double-click and
//      concurrent sends — only one request wins the row.
//   4. Salesforge send. On failure, roll back: set status='classified'
//      and record the error so the client can retry.
//
// Request body: { subject?: string, body_text: string, body_html?: string }
// `subject` is ignored — Salesforge infers the subject from the original
// thread server-side.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SalesforgeClient } from "@/lib/salesforge/client";
import { computeIdempotencyKey } from "@/lib/replies/send";
import type { LeadReply, SourceChannel } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface SendBody {
  subject?: string;
  body_text?: string;
  body_html?: string;
}

const MAX_ERROR_LEN = 500;
function truncErr(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > MAX_ERROR_LEN ? s.slice(0, MAX_ERROR_LEN) + "…" : s;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing reply id" }, { status: 400 });
  }

  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body_text = body.body_text?.trim();
  if (!body_text) {
    return NextResponse.json(
      { error: "body_text is required and must be non-empty." },
      { status: 400 }
    );
  }
  const body_html = body.body_html?.trim() || undefined;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: preRow, error: preLoadErr } = await admin
    .from("lead_replies")
    .select(
      "id, organization_id, client_id, status, source_channel, salesforge_email_id, salesforge_mailbox_id, client:client_id(notification_email, notification_cc_emails)"
    )
    .eq("id", id)
    .maybeSingle();
  if (preLoadErr) {
    return NextResponse.json({ error: preLoadErr.message }, { status: 500 });
  }
  if (!preRow) {
    return NextResponse.json({ error: "Reply not found" }, { status: 404 });
  }

  const pre = preRow as unknown as {
    id: string;
    organization_id: string;
    client_id: string;
    status: LeadReply["status"];
    source_channel: SourceChannel;
    salesforge_email_id: string | null;
    salesforge_mailbox_id: string | null;
    client: {
      notification_email: string | null;
      notification_cc_emails: string[] | null;
    } | null;
  };

  const role = user.app_metadata?.role;
  const userOrgId = user.app_metadata?.organization_id;
  if (role === "owner" || role === "va") {
    if (pre.organization_id !== userOrgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    const { data: link } = await admin
      .from("client_users")
      .select("client_id")
      .eq("user_id", user.id)
      .eq("client_id", pre.client_id)
      .maybeSingle();
    if (!link) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (pre.source_channel !== "salesforge") {
    return NextResponse.json(
      {
        error: `Sending replies from the ${pre.source_channel} channel is not supported. Only Salesforge replies can be sent from the portal.`,
      },
      { status: 501 }
    );
  }
  if (!pre.salesforge_email_id || !pre.salesforge_mailbox_id) {
    return NextResponse.json(
      {
        error:
          "This reply is missing the Salesforge metadata needed to send (salesforge_email_id / salesforge_mailbox_id). Check the webhook ingest.",
      },
      { status: 412 }
    );
  }

  const { data: orgRow, error: orgErr } = await admin
    .from("organizations")
    .select("salesforge_api_key, salesforge_workspace_id")
    .eq("id", pre.organization_id)
    .maybeSingle();
  if (orgErr || !orgRow) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }
  const org = orgRow as {
    salesforge_api_key: string | null;
    salesforge_workspace_id: string | null;
  };
  if (!org.salesforge_api_key) {
    return NextResponse.json(
      { error: "Salesforge API key is not configured for this organization." },
      { status: 500 }
    );
  }
  if (!org.salesforge_workspace_id) {
    return NextResponse.json(
      { error: "Salesforge workspace is not configured for this organization." },
      { status: 500 }
    );
  }

  // Atomic claim: only one send wins.
  const sentAt = new Date().toISOString();
  const idempotencyKey = computeIdempotencyKey(id, body_text);
  const { data: claimedRow, error: claimErr } = await admin
    .from("lead_replies")
    .update({
      status: "sent",
      sent_at: sentAt,
      final_body_text: body_text,
      final_body_html: body_html ?? null,
      error: null,
      idempotency_key: idempotencyKey,
    })
    .eq("id", id)
    .in("status", ["new", "classified"])
    .select(
      "id, salesforge_email_id, salesforge_mailbox_id, subject, body_text, status"
    )
    .maybeSingle();

  if (claimErr) {
    return NextResponse.json({ error: claimErr.message }, { status: 500 });
  }
  if (!claimedRow) {
    return NextResponse.json(
      { error: "Reply has already been sent or is no longer sendable." },
      { status: 409 }
    );
  }

  const claimed = claimedRow as Pick<
    LeadReply,
    "id" | "salesforge_email_id" | "salesforge_mailbox_id" | "subject" | "body_text"
  >;

  // CC the client's primary notification inbox + any teammates they
  // added. Lowercased + deduped so one stray duplicate doesn't cause
  // Salesforge to reject the send.
  const ccSet = new Set<string>();
  if (pre.client?.notification_email) {
    ccSet.add(pre.client.notification_email.trim().toLowerCase());
  }
  for (const addr of pre.client?.notification_cc_emails ?? []) {
    if (addr && addr.trim()) ccSet.add(addr.trim().toLowerCase());
  }
  const cc = ccSet.size > 0 ? Array.from(ccSet) : undefined;

  let sentExternalId: string | null = null;
  try {
    const salesforge = new SalesforgeClient(org.salesforge_api_key);
    const sentEmail = await salesforge.replyToEmail(
      org.salesforge_workspace_id,
      claimed.salesforge_mailbox_id!,
      claimed.salesforge_email_id!,
      {
        body_text,
        body_html,
        cc_addresses: cc,
      }
    );
    sentExternalId = sentEmail.id;
  } catch (err) {
    console.error("[replies/send] Salesforge reply API failed:", err);
    await admin
      .from("lead_replies")
      .update({
        status: "classified",
        sent_at: null,
        error: truncErr(err),
      })
      .eq("id", id);
    return NextResponse.json(
      { error: `Salesforge rejected the send: ${truncErr(err)}` },
      { status: 502 }
    );
  }

  // Record the upstream provider's new email id on the row.
  if (sentExternalId) {
    const { error: finalizeErr } = await admin
      .from("lead_replies")
      .update({ sent_external_email_id: sentExternalId })
      .eq("id", id);
    if (finalizeErr) {
      console.error(
        "[replies/send] Send succeeded but failed to record external email id:",
        finalizeErr
      );
    }
  }

  return NextResponse.json({
    success: true,
    sent_at: sentAt,
    sent_external_email_id: sentExternalId,
    cc_addresses: cc ?? [],
  });
}
