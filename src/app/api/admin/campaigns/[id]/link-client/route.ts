// POST /api/admin/campaigns/[id]/link-client
//
// Owner-only. Sets (or changes, or clears) a campaign's client link. Two callers:
//
//   1. The no-JS link-orphan form on /admin/campaigns/[id]: form-encoded
//      `client_id=<uuid>`, answered with a 303 redirect back to the campaign.
//      Form callers must pick a client (an empty value is rejected).
//   2. The Setup tab on the campaign workspace: JSON `{ client_id: <uuid>|null }`,
//      answered with JSON. A null/empty client_id unlinks the campaign (back to
//      orphan); any client_id re-points it, at any time.
//
// Catch-up notifications: replies ingested while the campaign was an orphan
// classified but skipped notification (client_id was NULL). When we link an
// orphan to a client we backfill their client_id and, after the response, fire
// the deferred hot-lead notifications: already-classified rows call
// sendHotLeadNotification directly (runReplyPipeline early-returns on
// classified rows), unclassified rows run the full pipeline. This is the path
// lazy-created orphan campaigns depend on. Changing between two
// clients, or unlinking, does not re-fire notifications.

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

  // Content-negotiate: JSON callers (the Setup tab) get JSON back and may pass
  // null to unlink; form callers (the no-JS orphan linker) get a redirect and
  // must supply a client_id.
  const isJson = req.headers.get("content-type")?.includes("application/json");
  let clientId: string | null;
  if (isJson) {
    let jsonBody: { client_id?: string | null };
    try {
      jsonBody = (await req.json()) as { client_id?: string | null };
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    clientId =
      typeof jsonBody.client_id === "string" && jsonBody.client_id
        ? jsonBody.client_id
        : null;
  } else {
    const form = await req.formData();
    const raw = form.get("client_id");
    if (typeof raw !== "string" || raw.length === 0) {
      return NextResponse.json({ error: "client_id is required" }, { status: 400 });
    }
    clientId = raw;
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

  // Verify the target client is in the same org and load its notification config
  // for the catch-up fan-out. Skipped when unlinking (clientId === null).
  let client: Client | null = null;
  if (clientId) {
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
    client = clientRow as Client;
  }

  // Snapshot the orphan replies BEFORE linking so we know which rows this link
  // owns. Only meaningful when the campaign is currently an orphan AND we're
  // attaching it to a client (not unlinking).
  let replyIds: string[] = [];
  let alreadyClassifiedIds: string[] = [];
  if (camp.client_id === null && clientId) {
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
  // notifications after the response returns. Only reachable when linking an
  // orphan to a client, so `client` is non-null here.
  if (client && replyIds.length > 0) {
    const linkedClient = client;
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
      // Already-classified orphans: sendHotLeadNotification directly,
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
          if (!linkedClient.notification_email) continue;
          if (!(linkedClient.auto_notify_classes || []).includes(reply.final_class)) {
            continue;
          }
          await sendHotLeadNotification(
            {
              reply,
              clientNotificationEmail: linkedClient.notification_email,
              clientNotificationCcEmails: linkedClient.notification_cc_emails ?? [],
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

  // JSON callers (the Setup tab) get JSON; form callers get a 303 redirect so
  // the browser does a GET on the campaign page after the POST.
  if (isJson) {
    return NextResponse.json({ success: true, client_id: clientId });
  }
  const origin = req.nextUrl.origin;
  return NextResponse.redirect(
    new URL(`/app/admin/campaigns/${campaignId}`, origin),
    303,
  );
}
