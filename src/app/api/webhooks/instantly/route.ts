// POST /api/webhooks/instantly — inbound webhook for the Instantly email channel.
//
// Mirrors src/app/api/webhooks/unipile/route.ts: optional ?secret= check,
// audit log to webhook_events, deferred reply pipeline via Next.js after().
//
// Instantly fires one subscription ("all_events"). We act on:
//   - reply_received → enrich via /emails/{id}, ingest into lead_replies,
//                      run the shared classify + hot-lead-notify pipeline.
// Everything else (email_sent / _opened / _bounced, lead_* events) is
// audit-logged and otherwise a no-op:
//   - Bounces + per-campaign stats arrive through the sync-analytics leg,
//     so there's no need to track them per-event here.
//   - Instantly suppresses unsubscribes on its own side (it won't email that
//     lead again), so we don't need to replicate the suppression.
//
// Org/client/campaign are resolved from the payload's Instantly campaign_id
// via campaigns.instantly_campaign_id. When that campaign isn't linked yet we
// lazy-create an orphan campaign (client_id NULL) so the reply still ingests
// and classifies; notification waits until an owner links the campaign.

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReplyPipeline } from "@/lib/replies/pipeline";
import { recordWebhookAuthFailure } from "@/lib/notifications/webhook-auth-alerts";
import { InstantlyClient } from "@/lib/instantly/client";
import type { InstantlyEmail, InstantlyWebhookPayload } from "@/lib/instantly/types";

// Read a string field off the loosely-typed webhook payload.
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

// Minimal HTML → text for the rare case where Instantly's /emails/{id}
// returns only an HTML body. The keyword classifier needs *some* text.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function bodyTextFromEmail(email: InstantlyEmail | null): string | null {
  if (!email) return null;
  const b = email.body;
  if (typeof b === "string") return b.trim() || null;
  if (b && typeof b === "object") {
    if (b.text && b.text.trim()) return b.text.trim();
    if (b.html && b.html.trim()) return stripHtml(b.html) || null;
  }
  return str(email.content_preview);
}

function bodyHtmlFromEmail(email: InstantlyEmail | null): string | null {
  if (!email) return null;
  const b = email.body;
  if (b && typeof b === "object" && typeof b.html === "string") return b.html;
  return null;
}

function nameFromEmail(email: InstantlyEmail | null): string | null {
  const entry = email?.from_address_json?.[0];
  return str(entry?.name);
}

export async function POST(request: NextRequest) {
  // Optional secret verification. If INSTANTLY_WEBHOOK_SECRET isn't set, no
  // check happens. Per-channel secret (matches UNIPILE_WEBHOOK_SECRET) so the
  // channels rotate independently.
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.INSTANTLY_WEBHOOK_SECRET;
  if (expectedSecret && secret !== expectedSecret) {
    after(async () => {
      try {
        await recordWebhookAuthFailure({
          admin: createAdminClient(),
          endpoint: "/api/webhooks/instantly",
          reason: "bad_secret",
          request,
        });
      } catch (err) {
        console.error("[webhooks/instantly] recordWebhookAuthFailure threw:", err);
      }
    });
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  let payload: InstantlyWebhookPayload;
  try {
    payload = (await request.json()) as InstantlyWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();
  const instantlyCampaignId = str(payload.campaign_id);

  // ───── Resolve org / client / campaign ───────────────────────────────────
  let organizationId: string | null = null;
  let clientId: string | null = null;
  let campaignId: string | null = null;
  let instantlyApiKey: string | null = null;

  if (instantlyCampaignId) {
    const { data: campaign } = await admin
      .from("campaigns")
      .select("id, client_id, organization_id")
      .eq("instantly_campaign_id", instantlyCampaignId)
      .limit(1)
      .maybeSingle();
    if (campaign) {
      const c = campaign as { id: string; client_id: string | null; organization_id: string };
      organizationId = c.organization_id;
      clientId = c.client_id;
      campaignId = c.id;
    }
  }

  // Fallback: attribute to the org that has Instantly configured (single-org
  // setups, and the attribution target for lazy-create below).
  if (!organizationId) {
    const { data: orgs } = await admin
      .from("organizations")
      .select("id, instantly_api_key")
      .not("instantly_api_key", "is", null)
      .limit(1);
    if (orgs?.[0]) {
      const o = orgs[0] as { id: string; instantly_api_key: string | null };
      organizationId = o.id;
      instantlyApiKey = o.instantly_api_key;
    }
  } else {
    const { data: org } = await admin
      .from("organizations")
      .select("instantly_api_key")
      .eq("id", organizationId)
      .maybeSingle();
    instantlyApiKey = (org as { instantly_api_key: string | null } | null)?.instantly_api_key ?? null;
  }

  if (!organizationId) {
    return NextResponse.json({ error: "No organization found" }, { status: 400 });
  }

  // Lazy-create an orphan campaign when we have an Instantly campaign_id but
  // no linked LeadStart campaign. client_id stays NULL — an owner links it to
  // a client later; the reply still ingests + classifies in the meantime.
  if (!campaignId && instantlyCampaignId) {
    campaignId = await lazyCreateCampaign(admin, organizationId, instantlyCampaignId, payload);
  }

  // Audit log (mirrors the Unipile handler's shape).
  await admin.from("webhook_events").insert({
    organization_id: organizationId,
    event_type: str(payload.event_type) ?? "unknown",
    lead_email: str(payload.lead_email) ?? str(payload.email),
    payload: payload as unknown as Record<string, unknown>,
    processed: false,
    source_channel: "instantly",
  });

  // ───── Branch by event ───────────────────────────────────────────────────
  // Gate on campaignId (not clientId) so orphan campaigns still ingest.
  let pipelineReplyId: string | null = null;
  if (str(payload.event_type) === "reply_received" && campaignId) {
    pipelineReplyId = await handleReplyReceived({
      admin,
      payload,
      organizationId,
      clientId,
      campaignId,
      instantlyApiKey,
    });
  }

  // Schedule classification + notification after the 200 returns to Instantly.
  if (pipelineReplyId) {
    const scheduledId = pipelineReplyId;
    after(async () => {
      try {
        await runReplyPipeline(scheduledId, admin);
      } catch (err) {
        console.error(`[webhooks/instantly] runReplyPipeline(${scheduledId}) threw:`, err);
      }
    });
  }

  return NextResponse.json({ received: true });
}

// ─────────────────────────────────────────────────────────────────────────
// Lazy-create an orphan campaign for an unseen Instantly campaign_id.
async function lazyCreateCampaign(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  instantlyCampaignId: string,
  payload: InstantlyWebhookPayload,
): Promise<string | null> {
  const campaignName =
    str(payload.campaign_name) || `Unknown Instantly campaign (${instantlyCampaignId})`;

  const { data: created, error } = await admin
    .from("campaigns")
    .insert({
      organization_id: organizationId,
      instantly_campaign_id: instantlyCampaignId,
      client_id: null,
      name: campaignName,
      status: "draft",
      source_channel: "instantly",
    })
    .select("id")
    .single();

  if (created && !error) {
    return (created as { id: string }).id;
  }

  // Unique-constraint race — a concurrent webhook just created it. Re-query.
  const { data: raced } = await admin
    .from("campaigns")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("instantly_campaign_id", instantlyCampaignId)
    .maybeSingle();
  if (raced) {
    return (raced as { id: string }).id;
  }

  console.error(
    `[webhooks/instantly] failed to lazy-create campaign for instantly_campaign_id=${instantlyCampaignId}:`,
    error,
  );
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// reply_received → enrich via /emails/{id}, upsert into lead_replies.
// Returns the reply id to run the pipeline on when a body is present; null
// otherwise (the row still exists and is visible in the inbox, just unclassified).
async function handleReplyReceived({
  admin,
  payload,
  organizationId,
  clientId,
  campaignId,
  instantlyApiKey,
}: {
  admin: ReturnType<typeof createAdminClient>;
  payload: InstantlyWebhookPayload;
  organizationId: string;
  clientId: string | null;
  campaignId: string;
  instantlyApiKey: string | null;
}): Promise<string | null> {
  // Instantly's Email-object UUID — always present on reply_received as
  // `email_id`. Our dedup key + the reply_to_uuid when sending a reply back.
  const instantlyEmailId =
    str((payload as Record<string, unknown>).email_id) ??
    str((payload as Record<string, unknown>).instantly_email_id);
  if (!instantlyEmailId) {
    console.warn("[webhooks/instantly] reply_received without email_id; skipping ingest");
    return null;
  }

  // Enrich the sparse webhook body with the full Email object (body, eaccount,
  // message_id, thread, sender name). getEmail retries 3x with backoff; on
  // failure we still ingest from the webhook payload rather than drop.
  let email: InstantlyEmail | null = null;
  if (instantlyApiKey) {
    try {
      email = await new InstantlyClient(instantlyApiKey).getEmail(instantlyEmailId);
    } catch (err) {
      console.error(
        `[webhooks/instantly] getEmail(${instantlyEmailId}) failed; ingesting from webhook payload only:`,
        err,
      );
    }
  } else {
    console.warn(
      "[webhooks/instantly] org has no instantly_api_key; ingesting reply from webhook payload only",
    );
  }

  const leadEmail = email?.from_address_email ?? str(payload.lead_email) ?? str(payload.email);
  if (!leadEmail) {
    // lead_replies.lead_email is NOT NULL — without any address we can't ingest.
    console.warn(
      `[webhooks/instantly] reply_received ${instantlyEmailId} has no lead_email; cannot ingest`,
    );
    return null;
  }

  const leadName =
    [payload.first_name, payload.last_name]
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .join(" ")
      .trim() ||
    nameFromEmail(email) ||
    null;

  const bodyText = bodyTextFromEmail(email);

  const row = {
    organization_id: organizationId,
    client_id: clientId,
    campaign_id: campaignId,
    source_channel: "instantly" as const,
    instantly_email_id: instantlyEmailId,
    instantly_message_id: email?.message_id ?? null,
    instantly_eaccount: email?.eaccount ?? null,
    instantly_thread_id: email?.thread_id ?? null,
    lead_email: leadEmail,
    lead_name: leadName,
    lead_company: str(payload.company_name),
    from_address: email?.from_address_email ?? leadEmail,
    subject: email?.subject ?? str(payload.subject),
    body_text: bodyText,
    body_html: bodyHtmlFromEmail(email),
    received_at: email?.timestamp_email ?? new Date().toISOString(),
    raw_payload: payload as unknown as Record<string, unknown>,
    status: "new" as const,
  };

  const { data, error } = await admin
    .from("lead_replies")
    .upsert(row, {
      onConflict: "organization_id,instantly_email_id",
      ignoreDuplicates: false,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[webhooks/instantly] lead_replies upsert failed:", error);
    return null;
  }

  // Only run the pipeline once we have content to classify. Without a body the
  // row stays 'new' and visible in the inbox — no zombie status, no retry cron.
  if (!bodyText || !bodyText.trim()) {
    console.warn(
      `[webhooks/instantly] reply ${instantlyEmailId} ingested without a body (enrichment unavailable); left unclassified`,
    );
    return null;
  }

  return (data as { id: string }).id;
}
