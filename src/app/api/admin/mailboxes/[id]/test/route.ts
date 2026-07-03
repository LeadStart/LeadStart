// POST /api/admin/mailboxes/[id]/test — send a one-off test email from a
// mailbox to prove domain-wide delegation end-to-end. Defaults to a
// self-send (mailbox → itself), which is always deliverable and lands in
// the same inbox so the operator can eyeball the From line. Not logged to
// native_sends (a test isn't a campaign send).
// Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { GmailConfigError, GmailAuthError } from "@/lib/gmail/client";
import { buildRawEmail, generateMessageId } from "@/lib/gmail/mime";
import type { NativeMailbox } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

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

  const to = (body.to ?? "").trim() || mailbox.email_address;

  try {
    const gmail = await loadGmailClientForOrg(admin, organizationId);
    const raw = buildRawEmail({
      fromEmail: mailbox.email_address,
      fromName: mailbox.display_name,
      to,
      subject: "LeadStart test send",
      bodyText:
        "This is a test email from LeadStart confirming that native sending " +
        `is working for ${mailbox.email_address}. If you can read this, ` +
        "domain-wide delegation is authorized correctly.",
      messageId: generateMessageId(mailbox.email_address),
    });
    const result = await gmail.sendMessage(mailbox.email_address, raw);
    return NextResponse.json({
      sent: true,
      to,
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
