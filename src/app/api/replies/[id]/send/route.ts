// POST /api/replies/[id]/send: send the client's edited reply back through the
// native Gmail mailbox that received it, threaded into the same conversation,
// and BCC the client's notification email so they get a copy without the lead
// seeing a third-party address on the thread. The lead's next reply comes back
// to the sending mailbox, gets ingested, and notifies the client as usual.
//
// Flow:
//   1. Auth + access check (client_users or admin/VA in the org).
//   2. Per-channel precondition check.
//   3. Atomic load+claim: UPDATE status='sent' WHERE id=:id AND status IN
//      ('new','classified') RETURNING *. Guards against double-click and
//      concurrent sends: only one request wins the row.
//   4. Channel send. On failure, roll back: set status='classified' and
//      record the error so the client can retry.
//
// Request body: { subject?: string, body_text: string, body_html?: string,
//                 attach_report?: boolean, attachments?: UploadedAttachment[] }
//
// attach_report: fetch the lead's own report PDF (contacts.custom_fields.
// report_link, see src/lib/replies/report-attachment.ts) and attach it.
// attachments: small hand-picked files, base64 in the JSON body. Both are
// resolved BEFORE the atomic claim, so a bad file never marks the reply sent.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeIdempotencyKey } from "@/lib/replies/send";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { buildRawEmail, generateMessageId, type EmailAttachment } from "@/lib/gmail/mime";
import { findReplyReport, fetchReportAttachment } from "@/lib/replies/report-attachment";
import { GmailConfigError, GmailAuthError } from "@/lib/gmail/client";
import type { LeadReply, SourceChannel } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface UploadedAttachment {
  filename?: string;
  content_type?: string;
  data_base64?: string;
}

interface SendBody {
  subject?: string;
  body_text?: string;
  body_html?: string;
  attach_report?: boolean;
  attachments?: UploadedAttachment[];
}

// Hand-picked uploads ride in the JSON request body. Vercel caps a function's
// request body (4.5 MB per their docs), and base64 inflates by a third, so
// keep the decoded total well under that.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_UPLOADS = 5;
const UPLOAD_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "text/csv",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function decodeUploads(list: UploadedAttachment[] | undefined): EmailAttachment[] {
  if (!list || list.length === 0) return [];
  if (list.length > MAX_UPLOADS) throw new Error(`Attach at most ${MAX_UPLOADS} files.`);
  let total = 0;
  return list.map((a) => {
    const type = (a.content_type ?? "").toLowerCase();
    if (!UPLOAD_TYPES.has(type)) {
      throw new Error(`${a.filename || "A file"} is a type we don't send (PDF, images, Office docs, CSV or text only).`);
    }
    const data = Buffer.from(a.data_base64 ?? "", "base64");
    if (data.length === 0) throw new Error(`${a.filename || "A file"} is empty.`);
    total += data.length;
    if (total > MAX_UPLOAD_BYTES) throw new Error("Attachments are too large (3 MB total max).");
    return { filename: a.filename || "attachment", contentType: type, data };
  });
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
  // Persisted to lead_replies.final_body_html on the atomic claim below; the
  // native Gmail send itself is text-only.
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
      "id, organization_id, client_id, campaign_id, status, source_channel, gmail_thread_id, gmail_message_id, native_mailbox_id, lead_email, from_address, subject, client:client_id(notification_email, notification_cc_emails)"
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
    campaign_id: string | null;
    status: LeadReply["status"];
    source_channel: SourceChannel;
    gmail_thread_id: string | null;
    gmail_message_id: string | null;
    native_mailbox_id: string | null;
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
  } else {
    return NextResponse.json(
      {
        error: `Sending replies from the ${pre.source_channel} channel is not supported from the portal.`,
      },
      { status: 501 }
    );
  }

  // ─── Attachments (resolved before the claim) ────────────────────────────
  let attachments: EmailAttachment[];
  try {
    attachments = decodeUploads(body.attachments);
    if (body.attach_report) {
      const report = await findReplyReport(admin, pre);
      if (!report) throw new Error("This lead has no report on file to attach.");
      attachments.unshift(await fetchReportAttachment(report));
    }
  } catch (err) {
    return NextResponse.json({ error: truncErr(err) }, { status: 400 });
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

  // BCC the client's primary notification inbox + any teammates they added.
  // Lowercased + deduped.
  const bccSet = new Set<string>();
  if (pre.client?.notification_email) {
    bccSet.add(pre.client.notification_email.trim().toLowerCase());
  }
  for (const addr of pre.client?.notification_cc_emails ?? []) {
    if (addr && addr.trim()) bccSet.add(addr.trim().toLowerCase());
  }
  const bcc = bccSet.size > 0 ? Array.from(bccSet) : undefined;

  // ─── Send back through the native Gmail mailbox that received the reply ─
  let sentExternalId: string | null = null;
  try {
    sentExternalId = await sendNativeReply(admin, pre, body_text, bcc, attachments);
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
    bcc_addresses: bcc ?? [],
    attachments: attachments.map((a) => a.filename),
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
  bcc: string[] | undefined,
  attachments: EmailAttachment[],
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
    bcc,
    attachments,
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
