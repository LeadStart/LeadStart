// POST /api/webhooks/unipile — inbound webhook for the LinkedIn channel.
//
// Mirrors /api/webhooks/instantly: optional ?secret= verification, audit
// log to webhook_events, deferred reply pipeline via Next.js after().
//
// Three event sources:
//   - messaging.message_received     → ingest into lead_replies, run pipeline
//   - account_status.disconnected /   → flip clients.unipile_account_status
//     credentials_invalid              to 'expired' (surfaces Reconnect button)
//   - account_status.connected       → flip back to 'connected' (backup signal;
//                                       the connect-callback handler is the
//                                       primary writer)
//
// users.invitation_* and messaging.message_read are audit-logged but
// otherwise no-op — sequence-engine handling lands in commit #7.

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReplyPipeline } from "@/lib/replies/pipeline";
import { recordWebhookAuthFailure } from "@/lib/notifications/webhook-auth-alerts";
import { UnipileClient } from "@/lib/unipile/client";
import type {
  UnipileWebhookEvent,
  UnipileMessagingEvent,
  UnipileAccountStatusEvent,
} from "@/lib/unipile/types";

interface ResolvedClient {
  id: string;
  organization_id: string;
  unipile_account_status: string | null;
}

export async function POST(request: NextRequest) {
  // Optional secret verification. If UNIPILE_WEBHOOK_SECRET isn't set, no
  // check happens — matches the WEBHOOK_SECRET pattern on the Instantly
  // handler. Kept separate so the two channels can rotate independently.
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.UNIPILE_WEBHOOK_SECRET;
  if (expectedSecret && secret !== expectedSecret) {
    after(async () => {
      try {
        await recordWebhookAuthFailure({
          admin: createAdminClient(),
          endpoint: "/api/webhooks/unipile",
          reason: "bad_secret",
          request,
        });
      } catch (err) {
        console.error(
          "[webhooks/unipile] recordWebhookAuthFailure threw:",
          err,
        );
      }
    });
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  let payload: UnipileWebhookEvent;
  try {
    payload = (await request.json()) as UnipileWebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Every event we care about is account-scoped. Resolve the client by
  // unipile_account_id; without a match we can't attribute the event and
  // there's nothing useful to do.
  const accountId =
    typeof (payload as { account_id?: unknown }).account_id === "string"
      ? (payload as { account_id: string }).account_id
      : null;
  if (!accountId) {
    return NextResponse.json({
      received: true,
      note: "no account_id on payload",
    });
  }

  const { data: clientRow } = await admin
    .from("clients")
    .select("id, organization_id, unipile_account_status")
    .eq("unipile_account_id", accountId)
    .maybeSingle();
  const client = clientRow as ResolvedClient | null;

  if (!client) {
    // Unknown account — likely a stale webhook from a previously-deleted
    // binding or an account that belongs to a different LeadStart org. Not
    // an error condition; we ack and move on so Unipile doesn't retry.
    return NextResponse.json({
      received: true,
      note: `unknown unipile_account_id=${accountId}`,
    });
  }

  // Audit log. event_type is the dotted form so the Events page can filter
  // by full event identity (e.g. messaging.message_received).
  const eventType = `${payload.source}.${payload.event}`;
  await admin.from("webhook_events").insert({
    organization_id: client.organization_id,
    event_type: eventType,
    campaign_instantly_id: null,
    lead_email: null,
    payload: payload as unknown as Record<string, unknown>,
    processed: false,
    source_channel: "linkedin",
  });

  // ───── Branch by source ──────────────────────────────────────────────
  let pipelineReplyId: string | null = null;

  if (
    payload.source === "messaging" &&
    payload.event === "message_received"
  ) {
    pipelineReplyId = await handleMessageReceived(admin, payload, client);
  } else if (payload.source === "account_status") {
    await handleAccountStatus(admin, payload, client);
  }

  // Schedule classification + notification after the response so the 200
  // returns to Unipile immediately. Same pattern as the Instantly handler.
  if (pipelineReplyId) {
    const scheduledId = pipelineReplyId;
    after(async () => {
      try {
        await runReplyPipeline(scheduledId, admin);
      } catch (err) {
        console.error(
          `[webhooks/unipile] runReplyPipeline(${scheduledId}) threw:`,
          err,
        );
      }
    });
  }

  return NextResponse.json({ received: true });
}

// ─────────────────────────────────────────────────────────────────────────
// messaging.message_received → ingest into lead_replies.
//
// We fetch the full message via UnipileClient.getMessage to read is_sender;
// outbound messages from the sequence engine could in theory fire the same
// event, and we don't want our own outreach masquerading as a reply. The
// fetch is best-effort — when org creds are missing or the call fails we
// fall back to the webhook payload's text and assume inbound.
async function handleMessageReceived(
  admin: ReturnType<typeof createAdminClient>,
  event: UnipileMessagingEvent,
  client: ResolvedClient,
): Promise<string | null> {
  let isSender = false;
  let bodyText = event.text ?? null;

  const { data: org } = await admin
    .from("organizations")
    .select("unipile_api_key, unipile_dsn")
    .eq("id", client.organization_id)
    .maybeSingle();
  const o = org as
    | { unipile_api_key: string | null; unipile_dsn: string | null }
    | null;

  if (o?.unipile_api_key && o?.unipile_dsn) {
    try {
      const unipile = new UnipileClient(o.unipile_api_key, o.unipile_dsn);
      const full = await unipile.getMessage(event.message_id);
      if (typeof full.is_sender === "boolean") {
        isSender = full.is_sender;
      }
      if (typeof full.text === "string" && full.text.trim().length > 0) {
        bodyText = full.text;
      }
    } catch (err) {
      console.warn(
        `[webhooks/unipile] getMessage(${event.message_id}) failed; ingesting from webhook payload only:`,
        err,
      );
    }
  }

  if (isSender) {
    return null;
  }

  if (!bodyText || !bodyText.trim()) {
    console.warn(
      `[webhooks/unipile] message_received ${event.message_id} has no text; skipping ingest`,
    );
    return null;
  }

  // Synthetic lead_email — lead_replies.lead_email is NOT NULL but
  // LinkedIn DMs don't carry an email address. Use a stable per-sender id
  // so a second message from the same sender is at least linkable.
  const syntheticEmail = `linkedin:${event.sender_id}`;

  const row = {
    organization_id: client.organization_id,
    client_id: client.id,
    campaign_id: null as string | null,
    source_channel: "linkedin" as const,
    unipile_message_id: event.message_id,
    unipile_chat_id: event.chat_id,
    lead_email: syntheticEmail,
    body_text: bodyText,
    received_at: event.timestamp,
    raw_payload: event as unknown as Record<string, unknown>,
    status: "new" as const,
  };

  const { data, error } = await admin
    .from("lead_replies")
    .upsert(row, {
      onConflict: "organization_id,unipile_message_id",
      ignoreDuplicates: false,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[webhooks/unipile] lead_replies upsert failed:", error);
    return null;
  }

  return (data as { id: string }).id;
}

// account_status.{disconnected | credentials_invalid | connected} → write
// the resulting status to the client row. Idempotent — skips the UPDATE
// when the value already matches.
async function handleAccountStatus(
  admin: ReturnType<typeof createAdminClient>,
  event: UnipileAccountStatusEvent,
  client: ResolvedClient,
): Promise<void> {
  let nextStatus: "connected" | "expired" | null = null;
  if (event.event === "disconnected" || event.event === "credentials_invalid") {
    nextStatus = "expired";
  } else if (event.event === "connected") {
    nextStatus = "connected";
  }

  if (!nextStatus) return;
  if (client.unipile_account_status === nextStatus) return;

  const { error } = await admin
    .from("clients")
    .update({ unipile_account_status: nextStatus })
    .eq("id", client.id);

  if (error) {
    console.error(
      `[webhooks/unipile] failed to update client ${client.id} status to ${nextStatus}:`,
      error,
    );
  }
}
