// POST /api/replies/[id]/send — send the client's edited reply back through the
// native Gmail mailbox that received it, threaded into the same conversation,
// and CC the client's notification email so the thread lives in their inbox.
//
// Flow:
//   1. Auth + access check (client_users or admin/VA in the org).
//   2. Per-channel precondition check.
//   3. Atomic load+claim: UPDATE status='sent' WHERE id=:id AND status IN
//      ('new','classified') RETURNING *. Guards against double-click and
//      concurrent sends — only one request wins the row.
//   4. Channel send. On failure, roll back: set status='classified' and
//      record the error so the client can retry.
//
// Request body: { subject?: string, body_text: string, body_html?: string }

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeIdempotencyKey } from "@/lib/replies/send";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { buildRawEmail, generateMessageId } from "@/lib/gmail/mime";
import { GmailConfigError, GmailAuthError } from "@/lib/gmail/client";
import type { LeadReply, SourceChannel } from "@/types/app";
import { InstantlyClient } from "@/lib/instantly/client";

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
      "id, organization_id, client_id, status, source_channel, gmail_thread_id, gmail_message_id, native_mailbox_id, instantly_eaccount, instantly_email_id, lead_email, from_address, subject, client:client_id(notification_email, notification_cc_emails)"
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
    gmail_thread_id: string | null;
    gmail_message_id: string | null;
    native_mailbox_id: string | null;
    instantly_eaccount: string | null;
    instantly_email_id: string | null;
    lead_email: string | null;
    from_address: string | null;
    subject: string | null;
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

  // ─── Precondition check per channel ─────────────────────────────────────
  if (pre.source_channel === "native_email") {
    if (!pre.native_mailbox_id || !pre.gmail_thread_id) {
      return NextResponse.json(
        {
          error:
            "This reply is missing the Gmail metadata needed to send (native_mailbox_id / gmail_thread_id).",
        },
        { status: 412 }
      );
    }
  } else if (pre.source_channel === "instantly") {
    if (!pre.instantly_eaccount || !pre.instantly_email_id) {
      return NextResponse.json(
        {
          error:
            "This reply is missing the Instantly metadata needed to send (eaccount / email id).",
        },
        { status: 412 }
      );
    }
  } else {
    return NextResponse.json(
      {
        error: `Sending replies from the ${pre.source_channel} channel is not supported from the portal.`,
      },
      { status: 501 }
    );
  }

  // ─── Atomic claim: only one send wins ──────────────────────────────────
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
    .select("id, status")
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

  // CC the client's primary notification inbox + any teammates they added.
  // Lowercased + deduped.
  const ccSet = new Set<string>();
  if (pre.client?.notification_email) {
    ccSet.add(pre.client.notification_email.trim().toLowerCase());
  }
  for (const addr of pre.client?.notification_cc_emails ?? []) {
    if (addr && addr.trim()) ccSet.add(addr.trim().toLowerCase());
  }
  const cc = ccSet.size > 0 ? Array.from(ccSet) : undefined;

  // ─── Send back through the channel that received the reply ─────────────
  let sentExternalId: string | null = null;
  try {
    sentExternalId =
      pre.source_channel === "instantly"
        ? await sendInstantlyReply(admin, pre, body_text, body_html, cc)
        : await sendNativeReply(admin, pre, body_text, cc);
  } catch (err) {
    console.error("[replies/send] channel send failed:", err);
    await admin
      .from("lead_replies")
      .update({ status: "classified", sent_at: null, error: truncErr(err) })
      .eq("id", id);
    return NextResponse.json(
      { error: `Send failed: ${truncErr(err)}` },
      { status: 502 }
    );
  }

  // Record the provider's new email id on the row.
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

// Send a portal reply through the native Gmail mailbox that received it,
// threaded into the same Gmail conversation. Returns the sent Gmail id.
async function sendNativeReply(
  admin: ReturnType<typeof createAdminClient>,
  pre: {
    organization_id: string;
    native_mailbox_id: string | null;
    gmail_thread_id: string | null;
    gmail_message_id: string | null;
    lead_email: string | null;
    from_address: string | null;
    subject: string | null;
  },
  bodyText: string,
  cc: string[] | undefined,
): Promise<string> {
  const { data: mbRow } = await admin
    .from("native_mailboxes")
    .select("email_address, display_name")
    .eq("id", pre.native_mailbox_id!)
    .eq("organization_id", pre.organization_id)
    .maybeSingle();
  const mailbox = mbRow as { email_address: string; display_name: string | null } | null;
  if (!mailbox) {
    throw new Error("The mailbox that received this reply no longer exists.");
  }

  const to = pre.lead_email || pre.from_address;
  if (!to) throw new Error("This reply has no recipient address to send to.");

  let gmail;
  try {
    gmail = await loadGmailClientForOrg(admin, pre.organization_id);
  } catch (err) {
    if (err instanceof GmailConfigError) throw new Error(err.message);
    throw err;
  }

  // Thread correctly: reference the inbound message's RFC Message-ID. Gmail
  // also threads via threadId, so this is best-effort.
  let inReplyTo: string | null = null;
  if (pre.gmail_message_id) {
    try {
      const meta = await gmail.getMessage(mailbox.email_address, pre.gmail_message_id, "metadata", ["Message-ID"]);
      const hdr = meta.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id");
      if (hdr?.value) inReplyTo = hdr.value;
    } catch {
      /* fall back to threadId-only threading */
    }
  }

  const baseSubject = (pre.subject ?? "").trim();
  const subject = !baseSubject
    ? "Re: (no subject)"
    : baseSubject.toLowerCase().startsWith("re:")
      ? baseSubject
      : `Re: ${baseSubject}`;

  const raw = buildRawEmail({
    fromEmail: mailbox.email_address,
    fromName: mailbox.display_name,
    to,
    cc,
    subject,
    bodyText,
    messageId: generateMessageId(mailbox.email_address),
    inReplyTo,
    references: inReplyTo,
  });

  try {
    const result = await gmail.sendMessage(mailbox.email_address, raw, pre.gmail_thread_id!);
    return result.id;
  } catch (err) {
    if (err instanceof GmailAuthError) {
      throw new Error(`Gmail rejected the send (mailbox delegation issue): ${err.message}`);
    }
    throw err;
  }
}

// Send a portal reply back through Instantly's /emails/reply endpoint — from
// the hosted mailbox (eaccount) that received it, threaded onto the inbound
// email (reply_to_uuid). Returns the new Instantly email id.
async function sendInstantlyReply(
  admin: ReturnType<typeof createAdminClient>,
  pre: {
    organization_id: string;
    instantly_eaccount: string | null;
    instantly_email_id: string | null;
    subject: string | null;
  },
  bodyText: string,
  bodyHtml: string | undefined,
  cc: string[] | undefined,
): Promise<string> {
  if (!pre.instantly_eaccount) {
    throw new Error("This reply is missing the Instantly mailbox (eaccount) to send from.");
  }
  if (!pre.instantly_email_id) {
    throw new Error("This reply is missing the Instantly email id needed to thread the reply.");
  }

  const { data: org } = await admin
    .from("organizations")
    .select("instantly_api_key")
    .eq("id", pre.organization_id)
    .maybeSingle();
  const apiKey =
    (org as { instantly_api_key: string | null } | null)?.instantly_api_key ||
    process.env.INSTANTLY_API_KEY ||
    "";
  if (!apiKey) {
    throw new Error("Instantly API key not set for this organization.");
  }

  const baseSubject = (pre.subject ?? "").trim();
  const subject = !baseSubject
    ? "Re: (no subject)"
    : baseSubject.toLowerCase().startsWith("re:")
      ? baseSubject
      : `Re: ${baseSubject}`;

  const email = await new InstantlyClient(apiKey).replyViaEmailsApi({
    eaccount: pre.instantly_eaccount,
    reply_to_uuid: pre.instantly_email_id,
    subject,
    body: bodyHtml ? { text: bodyText, html: bodyHtml } : { text: bodyText },
    cc_address_email_list: cc && cc.length > 0 ? cc.join(",") : undefined,
  });
  return email.id;
}
