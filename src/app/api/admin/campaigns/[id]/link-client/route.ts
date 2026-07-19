// POST /api/admin/campaigns/[id]/link-client
//
// Owner-only. Attaches an orphan campaign (client_id IS NULL) to a
// LeadStart client. Accepts a form-encoded body so the link-orphan form on
// /admin/campaigns/[id] can submit without JS.
//
// Body: client_id=<uuid>
// Success: 303 redirect back to the campaign detail page.
//
// Catch-up notifications: replies ingested while the campaign was an orphan
// classified but skipped notification (client_id was NULL). On link we
// backfill their client_id and, after the response, fire the deferred
// hot-lead notifications — already-classified rows call
// sendHotLeadNotification directly (runReplyPipeline early-returns on
// classified rows), unclassified rows run the full pipeline. This is the
// path the Instantly webhook's lazy-created orphans depend on.

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReplyPipeline } from "@/lib/replies/pipeline";
import { sendHotLeadNotification } from "@/lib/notifications/send-hot-lead";
import type { Client, LeadReply } from "@/types/app";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json(
      { error: "No organization on user" },
      { status: 400 },
    );
  }

  const form = await req.formData();
  const clientId = form.get("client_id");
  if (typeof clientId !== "string" || clientId.length === 0) {
    return NextResponse.json(
      { error: "client_id is required" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Verify the campaign exists in this org.
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, client_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  const camp = campaign as {
    id: string;
    organization_id: string;
    client_id: string | null;
  };
  if (camp.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Verify the client is in the same org and load its notification config for
  // the catch-up fan-out.
  const { data: clientRow } = await admin
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .maybeSingle();
  if (!clientRow || (clientRow as Client).organization_id !== organizationId) {
    return NextResponse.json(
      { error: "Client not found in this organization" },
      { status: 400 },
    );
  }
  const client = clientRow as Client;

  // Snapshot the orphan replies BEFORE linking so we know which rows this link
  // owns. Only meaningful when the campaign is currently an orphan.
  let replyIds: string[] = [];
  let alreadyClassifiedIds: string[] = [];
  if (camp.client_id === null) {
    const { data: orphanReplies } = await admin
      .from("lead_replies")
      .select("id, final_class")
      .eq("campaign_id", campaignId)
      .is("client_id", null);
    replyIds = (orphanReplies || []).map((r) => r.id as string);
    alreadyClassifiedIds = (orphanReplies || [])
      .filter((r) => (r as { final_class: string | null }).final_class !== null)
      .map((r) => r.id as string);
  }
  const unclassifiedIds = replyIds.filter(
    (rid) => !alreadyClassifiedIds.includes(rid),
  );

  const { error: updateError } = await admin
    .from("campaigns")
    .update({ client_id: clientId, updated_at: new Date().toISOString() })
    .eq("id", campaignId);
  if (updateError) {
    return NextResponse.json(
      { error: `Update failed: ${updateError.message}` },
      { status: 500 },
    );
  }

  // Backfill client_id on the orphan replies + schedule the deferred
  // notifications after the response returns.
  if (replyIds.length > 0) {
    const { error: backfillErr } = await admin
      .from("lead_replies")
      .update({ client_id: clientId })
      .in("id", replyIds)
      .is("client_id", null);
    if (backfillErr) {
      console.error(
        "[admin/link-client] campaign linked but reply backfill failed:",
        backfillErr,
      );
    }

    const classifiedIds = alreadyClassifiedIds;
    const pendingIds = unclassifiedIds;
    after(async () => {
      // Already-classified orphans: sendHotLeadNotification directly —
      // runReplyPipeline early-returns on classified rows, so it can't fire
      // the deferred notification.
      for (const rid of classifiedIds) {
        try {
          const { data: replyRow } = await admin
            .from("lead_replies")
            .select("*")
            .eq("id", rid)
            .maybeSingle();
          if (!replyRow) continue;
          const reply = replyRow as LeadReply;
          if (!reply.final_class || reply.notified_at) continue;
          if (!client.notification_email) continue;
          if (!(client.auto_notify_classes || []).includes(reply.final_class)) {
            continue;
          }
          await sendHotLeadNotification(
            {
              reply,
              clientNotificationEmail: client.notification_email,
              clientNotificationCcEmails: client.notification_cc_emails ?? [],
            },
            admin,
          );
        } catch (err) {
          console.error(
            `[admin/link-client] sendHotLeadNotification(${rid}) threw:`,
            err,
          );
        }
      }
      // Unclassified orphans: run the full pipeline (classify + notify).
      for (const rid of pendingIds) {
        try {
          await runReplyPipeline(rid, admin);
        } catch (err) {
          console.error(`[admin/link-client] runReplyPipeline(${rid}) threw:`, err);
        }
      }
    });
  }

  // 303 so the browser does a GET on the redirect target after the POST.
  const origin = req.nextUrl.origin;
  return NextResponse.redirect(
    new URL(`/app/admin/campaigns/${campaignId}`, origin),
    303,
  );
}
