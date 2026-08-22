// POST /api/admin/mailboxes/[id]/test — send a one-off test email from a
// mailbox to an address of your choosing (defaults to the signed-in owner's
// login email). Body: { to?: string }.
//
// Why not a self-send any more: mail from a mailbox to itself never leaves the
// tenant and always lands in the inbox, so the old default only ever proved
// that delegation worked — which adding the mailbox already proves. Sending to
// an outside inbox is a real delivery, so besides exercising the whole
// JWT → token → send path it gives a quick manual placement read: open the
// recipient and see whether it arrived in Inbox, Promotions, or Spam. The copy
// is the same neutral probe the seed placement test uses (short, plain,
// link-free, signed by the mailbox) so the verdict reflects the mailbox, not a
// "TEST" subject line. For a measured, multi-seed answer with receiver-side
// auth verdicts, use the placement test (POST …/placement) instead.
//
// Not logged to native_sends (a test isn't a campaign send). Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { GmailConfigError, GmailAuthError } from "@/lib/gmail/client";
import { buildRawEmail, generateMessageId } from "@/lib/gmail/mime";
import { buildNeutralProbe } from "@/lib/deliverability/placement";
import type { NativeMailbox } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(req: NextRequest, { params }: RouteParams) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }
  const { id } = await params;

  let body: { to?: string } = {};
  try {
    body = (await req.json()) as { to?: string };
  } catch {
    /* optional body */
  }

  const admin = createAdminClient();
  const { data: mbRow } = await admin
    .from("native_mailboxes")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const mailbox = mbRow as NativeMailbox | null;
  if (!mailbox) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });

  const to = ((body.to ?? "").trim() || user.email || "").toLowerCase();
  if (!to || !EMAIL_RE.test(to)) {
    return NextResponse.json(
      { error: "Enter a recipient address for the test email." },
      { status: 400 },
    );
  }
  if (to === mailbox.email_address.toLowerCase()) {
    return NextResponse.json(
      {
        error:
          "Pick an address outside this mailbox — a message to itself never leaves the tenant, so it can't show you where your mail lands.",
      },
      { status: 400 },
    );
  }

  const senderName = mailbox.display_name?.trim() || mailbox.email_address.split("@")[0];
  const copy = buildNeutralProbe({ senderName, variant: Math.floor(Date.now() / 1000) });

  try {
    const gmail = await loadGmailClientForOrg(admin, organizationId);
    const messageId = generateMessageId(mailbox.email_address);
    const raw = buildRawEmail({
      fromEmail: mailbox.email_address,
      fromName: mailbox.display_name,
      to,
      subject: copy.subject,
      bodyText: copy.bodyText,
      messageId,
    });
    const result = await gmail.sendMessage(mailbox.email_address, raw);
    return NextResponse.json({
      sent: true,
      to,
      subject: copy.subject,
      rfc_message_id: messageId,
      gmail_message_id: result.id,
      gmail_thread_id: result.threadId,
    });
  } catch (err) {
    if (err instanceof GmailConfigError || err instanceof GmailAuthError) {
      // A previously-verified mailbox can lose delegation later; reflect that.
      await admin
        .from("native_mailboxes")
        .update({ status: "error", last_error: err.message, last_error_at: new Date().toISOString() })
        .eq("id", id)
        .eq("organization_id", organizationId);
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: `Test send failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
