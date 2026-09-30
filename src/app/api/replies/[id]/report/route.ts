// GET /api/replies/[id]/report: what the reply composer can offer for this lead.
//   { link, available, filename?, saved_reply }
//   - link: the lead's own report link (contacts.custom_fields.report_link) or
//     null. The composer's default: a link in the reply, since a report PDF
//     attached to a reply landed in spam (2026-09-29).
//   - available / filename: whether the report PDF can still be attached
//     (checked by reading the PDF redirect, without downloading it). Some
//     reports have no PDF at all; their link still works.
//   - saved_reply: the campaign's saved reply (campaigns.reply_template,
//     migration 00134) with this lead's {{tokens}} filled, or null.
// The PDF itself is fetched again at send time by the send route.
//
// Access: owner/VA in the reply's org, or the client_user who owns the reply.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { findReplyContact, reportFromFields } from "@/lib/replies/report-attachment";
import { renderSavedReply, type SavedReply, type SavedReplyInbox } from "@/lib/replies/saved-reply";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing reply id" }, { status: 400 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("lead_replies")
    .select("id, organization_id, client_id, campaign_id, gmail_thread_id, lead_email, native_mailbox_id")
    .eq("id", id)
    .maybeSingle();
  const reply = row as {
    organization_id: string;
    client_id: string;
    campaign_id: string | null;
    gmail_thread_id: string | null;
    lead_email: string | null;
    native_mailbox_id: string | null;
  } | null;
  if (!reply) return NextResponse.json({ error: "Reply not found" }, { status: 404 });

  const role = user.app_metadata?.role;
  if (role === "owner" || role === "va") {
    if (reply.organization_id !== user.app_metadata?.organization_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    const { data: link } = await admin
      .from("client_users")
      .select("client_id")
      .eq("user_id", user.id)
      .eq("client_id", reply.client_id)
      .maybeSingle();
    if (!link) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const contact = await findReplyContact(admin, reply);
  const report = reportFromFields(contact?.custom_fields ?? null);

  // The campaign's saved reply, filled in for this lead. Before migration 00134
  // is applied the column doesn't exist: that reads as "no saved reply".
  let savedReply: SavedReply | null = null;
  if (reply.campaign_id) {
    const { data: camp, error } = await admin
      .from("campaigns")
      .select("reply_template")
      .eq("id", reply.campaign_id)
      .maybeSingle();
    const template = error ? null : (camp as { reply_template: string | null } | null)?.reply_template ?? null;
    if (template && template.trim()) {
      let inbox: SavedReplyInbox | null = null;
      if (reply.native_mailbox_id) {
        const { data: mb } = await admin
          .from("native_mailboxes")
          .select("display_name, email_address, signature")
          .eq("id", reply.native_mailbox_id)
          .maybeSingle();
        inbox = (mb as SavedReplyInbox | null) ?? null;
      }
      savedReply = renderSavedReply(template, contact, inbox);
    }
  }

  if (!report) return NextResponse.json({ link: null, available: false, saved_reply: savedReply });

  // TuBe's report route is GET-only (HEAD is a 405) and answers format=pdf with
  // a 302 to the stored PDF, so read the redirect target without following it:
  // that confirms a PDF exists and names it, without downloading it.
  let filename = "report.pdf";
  try {
    const res = await fetch(report.pdfUrl, { redirect: "manual", cache: "no-store" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const base = decodeURIComponent(new URL(location, report.pdfUrl).pathname.split("/").pop() || "");
      if (base.toLowerCase().endsWith(".pdf")) filename = base;
    } else if (!res.ok || !(res.headers.get("content-type") ?? "").includes("pdf")) {
      return NextResponse.json({ link: report.link, available: false, reason: `pdf_http_${res.status}`, saved_reply: savedReply });
    }
  } catch {
    return NextResponse.json({ link: report.link, available: false, reason: "pdf_unreachable", saved_reply: savedReply });
  }

  return NextResponse.json({ link: report.link, available: true, filename, saved_reply: savedReply });
}
