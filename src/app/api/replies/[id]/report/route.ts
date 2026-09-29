// GET /api/replies/[id]/report: does this reply's lead have a report we can
// attach? Returns { available, link?, filename? } for the reply composer's
// "Attach report" chip. The PDF itself is fetched again at send time by the
// send route, so this is only a lookup (HEAD on the PDF to confirm it exists
// and learn its filename).
//
// Access: owner/VA in the reply's org, or the client_user who owns the reply.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { findReplyReport } from "@/lib/replies/report-attachment";

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
    .select("id, organization_id, client_id, campaign_id, gmail_thread_id, lead_email")
    .eq("id", id)
    .maybeSingle();
  const reply = row as {
    organization_id: string;
    client_id: string;
    campaign_id: string | null;
    gmail_thread_id: string | null;
    lead_email: string | null;
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

  const report = await findReplyReport(admin, reply);
  if (!report) return NextResponse.json({ available: false });

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
      return NextResponse.json({ available: false, reason: `pdf_http_${res.status}` });
    }
  } catch {
    return NextResponse.json({ available: false, reason: "pdf_unreachable" });
  }

  return NextResponse.json({ available: true, link: report.link, filename });
}
