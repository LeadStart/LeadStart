import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReplyPipeline } from "@/lib/replies/pipeline";
import { recordWebhookAuthFailure } from "@/lib/notifications/webhook-auth-alerts";
import {
  normalizeSalesforgeReplyFromWebhook,
  type SalesforgeWebhookPayload,
} from "@/lib/replies/ingest-salesforge";

// Salesforge webhook events we route into the reply pipeline. The
// remaining events (email_bounced, contact_unsubscribed, dnc_added,
// label_changed) are logged to webhook_events for the audit log but
// don't trigger reply ingestion.
const REPLY_EVENT_TYPES = new Set<string>([
  "email_replied",
  "positive_reply",
  "negative_reply",
]);

export async function POST(request: NextRequest) {
  // Auth — Salesforge does not sign payloads, so a shared-secret query
  // param is the auth surface.
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (expectedSecret && secret !== expectedSecret) {
    after(async () => {
      try {
        await recordWebhookAuthFailure({
          admin: createAdminClient(),
          endpoint: "/api/webhooks/salesforge",
          reason: "bad_secret",
          request,
        });
      } catch (err) {
        console.error(
          "[webhooks/salesforge] recordWebhookAuthFailure threw:",
          err
        );
      }
    });
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  let payload: SalesforgeWebhookPayload;
  try {
    payload = (await request.json()) as SalesforgeWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Salesforge's webhook payload shape is undocumented in the OpenAPI
  // spec, so every field read goes through pickStr with a fallback list.
  // Cascade test will refute or confirm the field names below.
  const sequenceId =
    pickStr(payload, "sequence_id") ??
    pickStr(payload, "sequence") ??
    pickStr(payload, "campaign_id");

  const eventType = pickStr(payload, "event_type") ?? pickStr(payload, "type") ?? "";

  const leadEmail =
    pickStr(payload, "lead_email") ??
    pickStr(payload, "from_email") ??
    pickStr(payload, "from_address") ??
    pickStr(payload, "contact_email") ??
    pickStr(payload, "email") ??
    null;

  // Resolve org/client/campaign via the sequence id. Lazy-create an
  // orphan campaign when we have a sequence id but no matching row.
  let organizationId: string | null = null;
  let clientId: string | null = null;
  let campaignId: string | null = null;

  if (sequenceId) {
    const { data: campaign } = await admin
      .from("campaigns")
      .select("id, client_id, organization_id")
      .eq("salesforge_sequence_id", sequenceId)
      .limit(1)
      .maybeSingle();

    if (campaign) {
      organizationId = (campaign as { organization_id: string }).organization_id;
      clientId = (campaign as { client_id: string | null }).client_id;
      campaignId = (campaign as { id: string }).id;
    }
  }

  // Fallback to the first org with a Salesforge key configured. Single-
  // org installs route every webhook here; multi-org installs rely on
  // the sequence id match above.
  if (!organizationId) {
    const { data: orgs } = await admin
      .from("organizations")
      .select("id")
      .not("salesforge_api_key", "is", null)
      .limit(1);
    if (orgs?.[0]) {
      organizationId = (orgs[0] as { id: string }).id;
    }
  }

  if (!organizationId) {
    return NextResponse.json({ error: "No organization found" }, { status: 400 });
  }

  // Lazy-create orphan campaign for unknown sequences. status='draft'
  // keeps it out of the analytics-active loop in sync-analytics until
  // an owner links it. source_channel='salesforge' is the per-row
  // discriminator the rest of the codebase branches on.
  if (!campaignId && sequenceId) {
    const sequenceName =
      pickStr(payload, "sequence_name") ??
      pickStr(payload, "campaign_name") ??
      `Unknown sequence (${sequenceId})`;
    const { data: created, error: createError } = await admin
      .from("campaigns")
      .insert({
        organization_id: organizationId,
        salesforge_sequence_id: sequenceId,
        client_id: null,
        name: sequenceName,
        status: "draft",
        source_channel: "salesforge",
      })
      .select("id")
      .single();
    if (created && !createError) {
      campaignId = (created as { id: string }).id;
    } else {
      // Unique-constraint race — another concurrent webhook just
      // created the row. Re-query so we still have the id.
      const { data: raced } = await admin
        .from("campaigns")
        .select("id, client_id, organization_id")
        .eq("salesforge_sequence_id", sequenceId)
        .limit(1)
        .maybeSingle();
      if (raced) {
        const row = raced as {
          id: string;
          client_id: string | null;
          organization_id: string;
        };
        campaignId = row.id;
        clientId = row.client_id;
        organizationId = row.organization_id;
      } else {
        console.error(
          `[webhooks/salesforge] Failed to lazy-create campaign for sequence_id=${sequenceId}:`,
          createError
        );
      }
    }
  }

  // Audit row — every webhook lands here regardless of whether it
  // triggers reply ingestion.
  await admin.from("webhook_events").insert({
    organization_id: organizationId,
    event_type: eventType,
    lead_email: leadEmail,
    payload: payload as unknown as Record<string, unknown>,
    processed: false,
    source_channel: "salesforge",
  });

  // Branch on event type. Reply events go through ingest + pipeline;
  // everything else is already in the audit log so we're done.
  let pipelineReplyId: string | null = null;
  if (REPLY_EVENT_TYPES.has(eventType) && campaignId) {
    pipelineReplyId = await ingestReply({
      admin,
      payload,
      organizationId,
      clientId,
      campaignId,
    });
  }

  // Schedule classification + notification AFTER the response — do
  // not block the 200 to Salesforge. Failure inside the callback logs
  // but doesn't resurface.
  if (pipelineReplyId) {
    const scheduledId = pipelineReplyId;
    after(async () => {
      try {
        await runReplyPipeline(scheduledId, admin);
      } catch (err) {
        console.error(
          `[webhooks/salesforge] runReplyPipeline(${scheduledId}) threw:`,
          err
        );
      }
    });
  }

  return NextResponse.json({ received: true });
}

function pickStr(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function ingestReply({
  admin,
  payload,
  organizationId,
  clientId,
  campaignId,
}: {
  admin: ReturnType<typeof createAdminClient>;
  payload: SalesforgeWebhookPayload;
  organizationId: string;
  clientId: string | null;
  campaignId: string;
}): Promise<string | null> {
  const normalized = normalizeSalesforgeReplyFromWebhook(payload, {
    organization_id: organizationId,
    client_id: clientId,
    campaign_id: campaignId,
  });

  if (!normalized) {
    console.warn(
      "[webhooks/salesforge] reply event missing required fields (salesforge_email_id or lead_email); dropping"
    );
    return null;
  }

  // Upsert on (organization_id, salesforge_email_id) — the dedup
  // constraint installed by migration 00049. Using a regular UNIQUE
  // (not partial) lets ON CONFLICT match without a WHERE predicate.
  const { data: upserted, error: upsertError } = await admin
    .from("lead_replies")
    .upsert(normalized, {
      onConflict: "organization_id,salesforge_email_id",
      ignoreDuplicates: false,
    })
    .select("id")
    .single();

  if (upsertError || !upserted) {
    console.error("[webhooks/salesforge] lead_replies upsert failed:", upsertError);
    return null;
  }

  return (upserted as { id: string }).id;
}
