// GET /api/replies/[id]/thread — the full email back-and-forth for one reply.
//
// native_sends stores no message body (it's an append-only send log), so the
// copy WE sent only lives in Gmail. This route pulls the whole Gmail thread by
// the reply's gmail_thread_id and returns each message tagged outbound/inbound,
// so the inbox conversation pane can show "what we sent" above "what they
// replied back with".
//
// It NEVER hard-fails the caller: anything that makes the live thread
// unavailable (legacy non-native reply, native email not configured, broken
// delegation, transient Gmail error) returns 200 with threadAvailable:false so
// the UI falls back to the reply row it already has.
//
// Access mirrors the outcome route: owner/VA in the reply's org, or the
// client_user who owns the reply (client_users link on reply.client_id).

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { GmailConfigError } from "@/lib/gmail/client";
import { parseGmailMessage } from "@/lib/gmail/mime";
import type { LeadReply } from "@/types/app";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export interface ThreadMessage {
  id: string;
  direction: "outbound" | "inbound";
  from: string | null; // raw "Name <email>" header
  fromEmail: string | null;
  subject: string | null;
  bodyText: string;
  at: string | null; // ISO timestamp
}

// Bare email out of a "Name <email>" header (or a raw address), lowercased.
function extractEmail(header: string | null): string | null {
  if (!header) return null;
  const angle = header.match(/<([^>]+)>/);
  const raw = (angle ? angle[1] : header).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(raw) ? raw : null;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing reply id" }, { status: 400 });
  }

  // --- Auth ---
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // --- Load the reply (access check + Gmail routing fields) ---
  const { data: row, error: loadErr } = await admin
    .from("lead_replies")
    .select(
      "id, organization_id, client_id, source_channel, gmail_thread_id, native_mailbox_id, to_address, from_address",
    )
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ error: loadErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "Reply not found" }, { status: 404 });
  }
  const reply = row as Pick<
    LeadReply,
    | "id"
    | "organization_id"
    | "client_id"
    | "source_channel"
    | "gmail_thread_id"
    | "native_mailbox_id"
    | "to_address"
    | "from_address"
  >;

  // --- Access check (same shape as the outcome route) ---
  const role = user.app_metadata?.role;
  const userOrgId = user.app_metadata?.organization_id;
  if (role === "owner" || role === "va") {
    if (reply.organization_id !== userOrgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    const { data: link } = await admin
      .from("client_users")
      .select("client_id")
      .eq("user_id", user.id)
      .eq("client_id", reply.client_id)
      .maybeSingle();
    if (!link) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // --- Only native-email replies have a Gmail thread to pull ---
  if (reply.source_channel !== "native_email" || !reply.gmail_thread_id) {
    return NextResponse.json({ threadAvailable: false, reason: "unsupported_channel", messages: [] });
  }

  // The impersonation subject is the mailbox the reply landed in. Prefer the
  // native_mailboxes row (authoritative address); fall back to to_address.
  let mailboxEmail = reply.to_address ?? null;
  if (reply.native_mailbox_id) {
    const { data: mb } = await admin
      .from("native_mailboxes")
      .select("email_address")
      .eq("id", reply.native_mailbox_id)
      .maybeSingle();
    if ((mb as { email_address: string } | null)?.email_address) {
      mailboxEmail = (mb as { email_address: string }).email_address;
    }
  }
  if (!mailboxEmail) {
    return NextResponse.json({ threadAvailable: false, reason: "no_mailbox", messages: [] });
  }

  // --- Pull the live thread; degrade to reply-only on any failure ---
  try {
    const gmail = await loadGmailClientForOrg(admin, reply.organization_id);
    const thread = await gmail.getThread(mailboxEmail, reply.gmail_thread_id);
    const mailboxLc = mailboxEmail.toLowerCase();

    const messages: ThreadMessage[] = thread.messages
      .map((m) => {
        const parsed = parseGmailMessage(m);
        const fromEmail = extractEmail(parsed.from);
        return {
          id: m.id,
          // A message From the sending mailbox is us (the initial send + any
          // portal reply, which is also sent from that mailbox); everything
          // else is the lead.
          direction: (fromEmail === mailboxLc ? "outbound" : "inbound") as
            | "outbound"
            | "inbound",
          from: parsed.from,
          fromEmail,
          subject: parsed.subject,
          bodyText: parsed.bodyText,
          at: parsed.internalDateMs ? new Date(parsed.internalDateMs).toISOString() : null,
        };
      })
      .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

    return NextResponse.json({ threadAvailable: true, mailbox: mailboxEmail, messages });
  } catch (err) {
    // GmailConfigError = native email not set up for this org; anything else =
    // delegation/transient. Either way the UI already has the reply row, so we
    // return a clean "not available" instead of a 5xx.
    const reason = err instanceof GmailConfigError ? "not_configured" : "gmail_error";
    if (!(err instanceof GmailConfigError)) {
      console.error("[replies/thread] gmail thread fetch failed:", err);
    }
    return NextResponse.json({ threadAvailable: false, reason, messages: [] });
  }
}
