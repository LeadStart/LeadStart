// POST /api/replies/[id]/send — send the client's edited reply through
// Instantly's native reply API and CC the client's notification email so
// the thread lives in their inbox.
//
// Flow:
//   1. Auth + access check (client_users or admin/VA in the org).
//   2. Atomic load+claim: UPDATE status='sent' WHERE id=:id AND status IN
//      ('new','classified') RETURNING *. Guards against double-click and
//      concurrent sends — only one request wins the row.
//   3. Build the Instantly request via buildReplyRequest (reads eaccount
//      + reply_to_uuid back out of the claimed row — the eaccount roundtrip).
//   4. Call InstantlyClient.replyViaEmailsApi. On success, record the new
//      instantly email id. On failure, roll back: set status='classified'
//      and record the error so the client can retry.
//
// Request body: { subject?: string, body_text: string, body_html?: string }
// `subject` defaults to the inbound's "Re:" form inside buildReplyRequest.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";
import {
  buildReplyRequest,
  computeIdempotencyKey,
  MissingReplyFieldError,
} from "@/lib/replies/send";
import type { LeadReply } from "@/types/app";

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

  // --- Parse body ---
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
  const subject = body.subject?.trim() || undefined;
  const body_html = body.body_html?.trim() || undefined;

  // --- Auth ---
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // --- Precheck: load reply for access + org key lookup (no state change) ---
  const { data: preRow, error: preLoadErr } = await admin
    .from("lead_replies")
    .select(
      "id, organization_id, client_id, status, eaccount, instantly_email_id, client:client_id(notification_email, notification_cc_emails)"
    )
    .eq("id", id)
    .maybeSingle();
  if (preLoadErr) {
    return NextResponse.json({ error: preLoadErr.message }, { status: 500 });
  }
  if (!preRow) {
    return NextResponse.json({ error: "Reply not found" }, { status: 404 });
  }

  // Supabase's generated types infer foreign-keyed relations as arrays even
  // when the FK is to a single row, so go through `unknown` to land on the
  // single-object shape we actually get at runtime.
  const pre = preRow as unknown as {
    id: string;
    organization_id: string;
    client_id: string;
    status: LeadReply["status"];
    eaccount: string | null;
    instantly_email_id: string | null;
    client: {
      notification_email: string | null;
      notification_cc_emails: string[] | null;
    } | null;
  };

  // --- Access check ---
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

  // --- Precondition: sendable fields present ---
  if (!pre.eaccount || !pre.instantly_email_id) {
    return NextResponse.json(
      {
        error:
          "This reply is missing the Instantly metadata needed to send (eaccount / instantly_email_id). Check the webhook ingest.",
      },
      { status: 412 }
    );
  }

  // --- Fetch org Instantly API key ---
  const { data: orgRow, error: orgErr } = await admin
    .from("organizations")
    .select("instantly_api_key")
    .eq("id", pre.organization_id)
    .maybeSingle();
  if (orgErr || !orgRow) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }
  const orgKey = (orgRow as { instantly_api_key: string | null }).instantly_api_key;
  if (!orgKey) {
    return NextResponse.json(
      { error: "Instantly API key is not configured for this organization." },
      { status: 500 }
    );
  }

  // --- Atomic claim: only one send wins ---
  // Also stamp a deterministic idempotency_key derived from (reply.id,
  // body_text). Instantly doesn't honor an Idempotency-Key header, so the
  // key is purely local state for D2 — persists through error rollbacks
  // so a future commit can add an active pre-check against repeated sends
  // of the same body after a timeout.
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
      "id, eaccount, instantly_email_id, subject, body_text, status"
    )
    .maybeSingle();

  if (claimErr) {
    return NextResponse.json({ error: claimErr.message }, { status: 500 });
  }
  if (!claimedRow) {
    // Someone else sent it (or status already moved to resolved/expired).
    return NextResponse.json(
      { error: "Reply has already been sent or is no longer sendable." },
      { status: 409 }
    );
  }

  const claimed = claimedRow as Pick<
    LeadReply,
    "id" | "eaccount" | "instantly_email_id" | "subject" | "body_text"
  >;

  // --- Build Instantly request ---
  // CC the client's primary notification inbox + any teammates they added.
  // Lowercased + deduped so one stray duplicate doesn't cause Instantly to
  // reject the send.
  const ccSet = new Set<string>();
  if (pre.client?.notification_email) {
    ccSet.add(pre.client.notification_email.trim().toLowerCase());
  }
  for (const addr of pre.client?.notification_cc_emails ?? []) {
    if (addr && addr.trim()) ccSet.add(addr.trim().toLowerCase());
  }
  const cc = ccSet.size > 0 ? Array.from(ccSet) : undefined;

  let request;
  try {
    request = buildReplyRequest({
      reply: claimed,
      body_text,
      body_html,
      subject,
      cc_addresses: cc,
    });
  } catch (err) {
    // Defense-in-depth: the precheck above already guards eaccount/id.
    await admin
      .from("lead_replies")
      .update({
        status: "classified",
        sent_at: null,
        final_body_text: null,
        final_body_html: null,
        error: truncErr(err),
      })
      .eq("id", id);
    const status = err instanceof MissingReplyFieldError ? 412 : 500;
    return NextResponse.json({ error: truncErr(err) }, { status });
  }

  // --- Send ---
  let sentEmail;
  try {
    const instantly = new InstantlyClient(orgKey);
    sentEmail = await instantly.replyViaEmailsApi(request);
  } catch (err) {
    // Roll back the claim so the client can retry. Leave final_body_text
    // populated so their edits aren't lost.
    console.error("[replies/send] Instantly reply API failed:", err);
    await admin
      .from("lead_replies")
      .update({
        status: "classified",
        sent_at: null,
        error: truncErr(err),
      })
      .eq("id", id);
    return NextResponse.json(
      { error: `Instantly rejected the send: ${truncErr(err)}` },
      { status: 502 }
    );
  }

  // --- Finalize: record Instantly's new email id on the row ---
  const { error: finalizeErr } = await admin
    .from("lead_replies")
    .update({ sent_instantly_email_id: sentEmail.id })
    .eq("id", id);
  if (finalizeErr) {
    // The send succeeded on Instantly's side; only the local reference
    // write failed. Surface a 200 with a warning rather than confusing the
    // UI into thinking the send failed.
    console.error(
      "[replies/send] Send succeeded but failed to record sent_instantly_email_id:",
      finalizeErr
    );
  }

  return NextResponse.json({
    success: true,
    sent_at: sentAt,
    sent_instantly_email_id: sentEmail.id,
    cc_addresses: cc ?? [],
  });
}
