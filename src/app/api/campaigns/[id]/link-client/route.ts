// PATCH /api/campaigns/[id]/link-client — owner-only: assign an orphan
// campaign (client_id IS NULL) to a LeadStart client.
//
// Side effects (in order):
//   1. UPDATE campaigns.client_id = <body.client_id>.
//   2. UPDATE every lead_replies row with matching campaign_id AND client_id IS NULL
//      to carry the same client_id.
//   3. For each of those replies, schedule a post-response job via after():
//      - already-classified (final_class set) + class in client.auto_notify_classes
//        + client.notification_email set → call sendHotLeadNotification directly.
//        (runReplyPipeline early-returns on already-classified rows per
//         src/lib/replies/pipeline.ts:51, so we can't just re-enter the pipeline
//         to fire the deferred notification. This branch is the B3-specific
//         re-notification path for orphans captured by B2.)
//      - not yet classified (no final_class) → call runReplyPipeline, which
//        will classify + notify normally.
//
// Invariants:
//   - One campaign ↔ one client: the campaign must be orphan (client_id IS NULL).
//     Relinking an already-linked campaign is rejected as a 409.
//   - No cross-org links: the target client must share organization_id with
//     the campaign. UI filters this; server enforces it.

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReplyPipeline } from "@/lib/replies/pipeline";
import { sendHotLeadNotification } from "@/lib/notifications/send-hot-lead";
import type { Campaign, Client, LeadReply } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface LinkClientBody {
  client_id?: string;
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing campaign id" }, { status: 400 });
  }

  let body: LinkClientBody;
  try {
    body = (await req.json()) as LinkClientBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const clientId = body.client_id;
  if (!clientId || typeof clientId !== "string") {
    return NextResponse.json({ error: "client_id is required" }, { status: 400 });
  }

  // --- Auth: owner only ---
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
  const userOrgId = user.app_metadata?.organization_id as string | undefined;
  if (!userOrgId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  const admin = createAdminClient();

  // --- Load campaign + verify orphan + same org ---
  const { data: campaignRow, error: campaignErr } = await admin
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (campaignErr) {
    return NextResponse.json({ error: campaignErr.message }, { status: 500 });
  }
  if (!campaignRow) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  const campaign = campaignRow as Campaign;
  if (campaign.organization_id !== userOrgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (campaign.client_id !== null) {
    return NextResponse.json(
      { error: "Campaign is already linked to a client" },
      { status: 409 },
    );
  }

  // --- Load target client + verify same org ---
  const { data: clientRow, error: clientErr } = await admin
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .maybeSingle();
  if (clientErr) {
    return NextResponse.json({ error: clientErr.message }, { status: 500 });
  }
  if (!clientRow) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  const client = clientRow as Client;
  if (client.organization_id !== campaign.organization_id) {
    return NextResponse.json(
      { error: "Cross-organization links are not allowed" },
      { status: 403 },
    );
  }

  // --- Snapshot orphan replies BEFORE updating so we know which rows this
  //     link owns for downstream notification work. Use id list only; we
  //     re-fetch full rows in the after() block so we see the UPDATE that
  //     populated client_id. ---
  const { data: orphanReplies, error: orphanErr } = await admin
    .from("lead_replies")
    .select("id, final_class")
    .eq("campaign_id", campaign.id)
    .is("client_id", null);
  if (orphanErr) {
    return NextResponse.json({ error: orphanErr.message }, { status: 500 });
  }
  const replyIds = (orphanReplies || []).map((r) => r.id as string);
  const alreadyClassifiedIds = (orphanReplies || [])
    .filter((r) => (r as { final_class: string | null }).final_class !== null)
    .map((r) => r.id as string);
  const unclassifiedIds = replyIds.filter((rid) => !alreadyClassifiedIds.includes(rid));

  // --- Link the campaign ---
  const { error: updateCampaignErr } = await admin
    .from("campaigns")
    .update({ client_id: client.id })
    .eq("id", campaign.id)
    .is("client_id", null); // idempotency guard against a concurrent link
  if (updateCampaignErr) {
    return NextResponse.json(
      { error: `Failed to link campaign: ${updateCampaignErr.message}` },
      { status: 500 },
    );
  }

  // --- Backfill client_id on the orphan replies ---
  if (replyIds.length > 0) {
    const { error: updateRepliesErr } = await admin
      .from("lead_replies")
      .update({ client_id: client.id })
      .in("id", replyIds)
      .is("client_id", null);
    if (updateRepliesErr) {
      // Campaign is already linked; log and continue so the caller can
      // retry the notification fan-out separately if needed.
      console.error(
        "[link-client] campaign linked but reply backfill failed:",
        updateRepliesErr,
      );
    }
  }

  // --- Schedule notification fan-out after we return 200 ---
  if (alreadyClassifiedIds.length > 0 || unclassifiedIds.length > 0) {
    const classifiedIds = alreadyClassifiedIds;
    const pendingIds = unclassifiedIds;
    after(async () => {
      // Already-classified orphans: re-fetch and call sendHotLeadNotification
      // directly. runReplyPipeline is the wrong tool here — its early-return
      // on final_class skips the notify step entirely.
      for (const rid of classifiedIds) {
        try {
          const { data: replyRow } = await admin
            .from("lead_replies")
            .select("*")
            .eq("id", rid)
            .maybeSingle();
          if (!replyRow) continue;
          const reply = replyRow as LeadReply;
          if (!reply.final_class) continue;
          if (reply.notified_at) continue;
          if (!client.notification_email) continue;
          const autoNotify = client.auto_notify_classes || [];
          if (!autoNotify.includes(reply.final_class)) continue;
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
            `[link-client] sendHotLeadNotification(${rid}) threw:`,
            err,
          );
        }
      }
      // Unclassified orphans: run the full pipeline so classification +
      // notification happen together.
      for (const rid of pendingIds) {
        try {
          await runReplyPipeline(rid, admin);
        } catch (err) {
          console.error(
            `[link-client] runReplyPipeline(${rid}) threw:`,
            err,
          );
        }
      }
    });
  }

  return NextResponse.json({
    success: true,
    campaign_id: campaign.id,
    client_id: client.id,
    replies_updated: replyIds.length,
    notifications_queued: alreadyClassifiedIds.length,
    pipeline_runs_queued: unclassifiedIds.length,
  });
}
