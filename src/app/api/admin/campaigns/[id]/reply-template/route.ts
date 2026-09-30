// PUT /api/admin/campaigns/[id]/reply-template: save (or clear) the campaign's
// saved reply for hot leads (campaigns.reply_template, migration 00134).
// Owner-only, org-scoped, like the campaign copy editor.
//
// Body: { reply_template: string | null }. Blank or null clears it. The text is
// the owner's; {{tokens}} fill per lead when the admin inbox's reply box opens
// (src/lib/replies/saved-reply.ts).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cleanReplyTemplate } from "@/lib/replies/saved-reply";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return NextResponse.json({ error: "No organization on user" }, { status: 400 });

  let body: { reply_template?: unknown };
  try {
    body = (await req.json()) as { reply_template?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  let template: string | null;
  try {
    template = cleanReplyTemplate(body.reply_template);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid saved reply" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id")
    .eq("id", campaignId)
    .maybeSingle();
  const camp = campaign as { id: string; organization_id: string } | null;
  if (!camp) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (camp.organization_id !== organizationId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { error } = await admin
    .from("campaigns")
    .update({ reply_template: template, updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("organization_id", organizationId);
  if (error) {
    const missingColumn = /reply_template/.test(error.message) && /column|schema cache/i.test(error.message);
    return NextResponse.json(
      { error: missingColumn ? "Saved replies need database migration 00134, which isn't applied yet." : error.message },
      { status: missingColumn ? 409 : 500 },
    );
  }
  return NextResponse.json({ reply_template: template });
}
