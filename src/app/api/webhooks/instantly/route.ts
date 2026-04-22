import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InstantlyWebhookPayload } from "@/lib/instantly/types";
import { InstantlyClient } from "@/lib/instantly/client";
import { normalizeReplyFromInstantlyEmail } from "@/lib/replies/ingest";
import { correlateTag } from "@/lib/replies/tag";
import { runReplyPipeline } from "@/lib/replies/pipeline";

export async function POST(request: NextRequest) {
  // Verify webhook secret (optional security via query param)
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  let payload: InstantlyWebhookPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Resolve organization + client + campaign via the Instantly campaign_id
  // on the payload. When the campaign_id references a campaign we haven't
  // imported yet (or haven't linked to a LeadStart client), we lazy-create
  // an orphan campaign row so the reply isn't dropped. Instantly does not
  // fire a campaign_created webhook event (verified against their docs —
  // only campaign_completed exists), so lazy-create-on-reply is the only
  // onboarding path besides the sync cron / admin button.
  let organizationId: string | null = null;
  let clientId: string | null = null;
  let campaignId: string | null = null;       // our DB campaign id
  let instantlyApiKey: string | null = null;

  if (payload.campaign_id) {
    const { data: campaign } = await admin
      .from("campaigns")
      .select("id, client_id, organization_id")
      .eq("instantly_campaign_id", payload.campaign_id)
      .limit(1)
      .maybeSingle();

    if (campaign) {
      organizationId = (campaign as { organization_id: string }).organization_id;
      clientId = (campaign as { client_id: string | null }).client_id;
      campaignId = (campaign as { id: string }).id;
    }
  }

  // Fallback to first org for events without a matchable campaign (keeps
  // existing behavior for single-org setups). Also serves as the
  // attribution fallback for lazy-create below.
  if (!organizationId) {
    const { data: orgs } = await admin
      .from("organizations")
      .select("id, instantly_api_key")
      .limit(1);
    if (orgs?.[0]) {
      organizationId = (orgs[0] as { id: string }).id;
      instantlyApiKey = (orgs[0] as { instantly_api_key: string | null }).instantly_api_key;
    }
  } else {
    // We have the org via the campaign; pick up its API key for enrichment.
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

  // Lazy-create orphan campaign when we have an Instantly campaign_id but
  // no matching row. client_id stays NULL — owner links it to a LeadStart
  // client later via the B3 triage UI. Status defaults to 'draft' so the
  // row doesn't immediately get swept into the analytics-active-campaigns
  // loop in src/app/api/cron/sync-analytics/route.ts.
  if (!campaignId && payload.campaign_id) {
    const campaignName =
      (typeof payload.campaign_name === "string" && payload.campaign_name.trim()) ||
      `Unknown campaign (${payload.campaign_id})`;
    const { data: created, error: createError } = await admin
      .from("campaigns")
      .insert({
        organization_id: organizationId,
        instantly_campaign_id: payload.campaign_id,
        client_id: null,
        name: campaignName,
        status: "draft",
      })
      .select("id")
      .single();
    if (created && !createError) {
      campaignId = (created as { id: string }).id;
    } else {
      // Unique-constraint race — another concurrent webhook / sync just
      // created the row. Re-query so we still have the id.
      const { data: raced } = await admin
        .from("campaigns")
        .select("id, client_id, organization_id")
        .eq("instantly_campaign_id", payload.campaign_id)
        .limit(1)
        .maybeSingle();
      if (raced) {
        const row = raced as { id: string; client_id: string | null; organization_id: string };
        campaignId = row.id;
        clientId = row.client_id;
        organizationId = row.organization_id;
      } else {
        console.error(
          `[webhook] Failed to lazy-create campaign for instantly_campaign_id=${payload.campaign_id}:`,
          createError
        );
      }
    }
  }

  // Audit trail (unchanged)
  await admin.from("webhook_events").insert({
    organization_id: organizationId,
    event_type: payload.event_type,
    campaign_instantly_id: payload.campaign_id || null,
    lead_email: payload.lead_email || payload.email || null,
    payload: payload as unknown as Record<string, unknown>,
    processed: false,
  });

  // Per-step bounce tracking (unchanged from prior behavior)
  if (payload.event_type === "email_bounced" && payload.campaign_id && payload.step) {
    const { data: campaign } = await admin
      .from("campaigns")
      .select("id")
      .eq("instantly_campaign_id", payload.campaign_id)
      .limit(1)
      .single();

    if (campaign) {
      const today = new Date().toISOString().split("T")[0];
      const { data: existing } = await admin
        .from("campaign_step_metrics")
        .select("id, bounces, sent, bounce_rate")
        .eq("campaign_id", (campaign as { id: string }).id)
        .eq("step", payload.step)
        .eq("period_start", today)
        .single();

      if (existing) {
        const row = existing as { id: string; bounces: number | null; sent: number };
        const newBounces = (row.bounces || 0) + 1;
        const newBounceRate =
          row.sent > 0 ? Number(((newBounces / row.sent) * 100).toFixed(2)) : 0;
        await admin
          .from("campaign_step_metrics")
          .update({ bounces: newBounces, bounce_rate: newBounceRate })
          .eq("id", row.id);
      }
    }
  }

  // ───── Reply-routing branch ─────────────────────────────────────────────
  // reply_received: ingest the full email + dedupe into lead_replies.
  // lead_*       : correlate the tag onto an existing/placeholder row.
  // Everything else: already logged to webhook_events, nothing further.
  const eventType = payload.event_type || "";
  const payloadRecord = payload as unknown as Record<string, unknown>;
  // Instantly's actual field name is `email_id` on reply_received payloads.
  // Fall back to `instantly_email_id` in case other event types use the
  // longer name (haven't observed it, but cheap defensive read).
  const instantlyEmailIdFromPayload =
    (typeof payloadRecord.email_id === "string" && payloadRecord.email_id) ||
    (typeof payloadRecord.instantly_email_id === "string" && payloadRecord.instantly_email_id) ||
    null;

  // Gate on campaignId, not clientId — orphan campaigns (client_id IS NULL)
  // still get their replies ingested and classified; only the notification
  // step is deferred until an owner links the campaign via B3.
  let pipelineReplyId: string | null = null;

  if (eventType === "reply_received" && campaignId) {
    pipelineReplyId = await handleReplyReceived({
      admin,
      payload: payloadRecord,
      organizationId,
      clientId,
      campaignId,
      instantlyCampaignId: payload.campaign_id || null,
      instantlyEmailId: instantlyEmailIdFromPayload,
      instantlyApiKey,
    });
  } else if (eventType.startsWith("lead_") && campaignId) {
    const result = await correlateTag(
      payloadRecord,
      {
        organization_id: organizationId,
        client_id: clientId,
        campaign_id: campaignId,
        instantly_campaign_id: payload.campaign_id || null,
      },
      admin
    );
    if (result.replyId && result.bothSignalsPresent) {
      pipelineReplyId = result.replyId;
    }
  }

  // Schedule classification + notification after the response — do not
  // block the 200 to Instantly. Failure inside the callback logs but
  // doesn't resurface.
  if (pipelineReplyId) {
    const scheduledId = pipelineReplyId;
    after(async () => {
      try {
        await runReplyPipeline(scheduledId, admin);
      } catch (err) {
        console.error(`[webhook] runReplyPipeline(${scheduledId}) threw:`, err);
      }
    });
  }

  return NextResponse.json({ received: true });
}

// ─────────────────────────────────────────────────────────────────────────
// reply_received ingestion: enrich via /emails/{id}, normalize, upsert.
// Returns the reply id if we're ready to run the pipeline (body + tag
// both present), otherwise null.
async function handleReplyReceived({
  admin,
  payload,
  organizationId,
  clientId,
  campaignId,
  instantlyCampaignId,
  instantlyEmailId,
  instantlyApiKey,
}: {
  admin: ReturnType<typeof createAdminClient>;
  payload: Record<string, unknown>;
  organizationId: string;
  // Null for orphan replies; the pipeline classifies but skips notification.
  clientId: string | null;
  campaignId: string | null;
  instantlyCampaignId: string | null;
  instantlyEmailId: string | null;
  instantlyApiKey: string | null;
}): Promise<string | null> {
  if (!instantlyEmailId) {
    console.warn("[webhook] reply_received without instantly_email_id; skipping ingest");
    return null;
  }
  if (!instantlyApiKey) {
    console.warn("[webhook] org has no instantly_api_key; cannot enrich reply_received");
    return null;
  }

  // Enrich the sparse webhook body with the full Email object so we get
  // eaccount + body + threading. getEmail has 3-attempt backoff built in.
  let email;
  try {
    const instantly = new InstantlyClient(instantlyApiKey);
    email = await instantly.getEmail(instantlyEmailId);
  } catch (err) {
    // C2 safety net — rather than dropping the reply, park a minimal row
    // with status='pending_enrichment'. The retry-enrichment cron
    // (src/app/api/cron/retry-enrichment/route.ts) promotes the row to
    // 'new' once getEmail returns, then the pipeline runs normally.
    console.error(
      `[webhook] getEmail(${instantlyEmailId}) failed — parking for retry:`,
      err,
    );
    const leadEmail =
      (typeof payload.lead_email === "string" && payload.lead_email) ||
      (typeof payload.email === "string" && payload.email) ||
      null;
    if (!leadEmail) {
      // Absolute minimum for a lead_replies row is lead_email (NOT NULL
      // in the schema). Without it we really do have to drop.
      console.warn(
        `[webhook] reply_received ${instantlyEmailId} has no lead_email; cannot park for retry`,
      );
      return null;
    }
    // Dedupe against a prior park — if a retry already queued this
    // same instantly_email_id, don't insert a duplicate.
    const { data: existing } = await admin
      .from("lead_replies")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("instantly_email_id", instantlyEmailId)
      .maybeSingle();
    if (existing) {
      return (existing as { id: string }).id;
    }
    const { data: parked, error: parkError } = await admin
      .from("lead_replies")
      .insert({
        organization_id: organizationId,
        client_id: clientId,
        campaign_id: campaignId,
        instantly_email_id: instantlyEmailId,
        instantly_campaign_id: instantlyCampaignId,
        lead_email: leadEmail,
        lead_name:
          [payload.first_name, payload.last_name]
            .filter((p) => typeof p === "string" && p)
            .join(" ")
            .trim() || null,
        lead_company:
          typeof payload.company_name === "string" && payload.company_name
            ? payload.company_name
            : null,
        received_at: new Date().toISOString(),
        status: "pending_enrichment",
        raw_payload: payload as unknown as Record<string, unknown>,
      })
      .select("id")
      .single();
    if (parkError || !parked) {
      console.error(
        `[webhook] Failed to park pending_enrichment row for ${instantlyEmailId}:`,
        parkError,
      );
      return null;
    }
    // Do NOT schedule the pipeline — no body_text to classify. The retry
    // cron will schedule it once enrichment succeeds.
    return null;
  }

  const normalized = normalizeReplyFromInstantlyEmail(email, payload, {
    organization_id: organizationId,
    client_id: clientId,
    campaign_id: campaignId,
  });

  // Preserve the raw Instantly campaign id even if our campaign row is
  // missing — helps debugging unlinked-campaign cases.
  if (!normalized.instantly_campaign_id && instantlyCampaignId) {
    normalized.instantly_campaign_id = instantlyCampaignId;
  }

  // Dedupe on (organization_id, instantly_message_id). If a placeholder
  // row was already created by a prior lead_* tag event, upsert fills in
  // the body fields; otherwise this is a fresh insert.
  if (!normalized.instantly_message_id) {
    // No message_id means no stable dedupe key — fall back to a plain
    // insert keyed only by instantly_email_id match.
    const { data: byEmailId } = await admin
      .from("lead_replies")
      .select("id, instantly_category")
      .eq("organization_id", organizationId)
      .eq("instantly_email_id", normalized.instantly_email_id ?? "")
      .maybeSingle();

    if (byEmailId) {
      const row = byEmailId as { id: string };
      await admin.from("lead_replies").update(normalized).eq("id", row.id);
      return row.id;
    }

    const { data } = await admin
      .from("lead_replies")
      .insert(normalized)
      .select("id")
      .single();
    if (!data) return null;
    return (data as { id: string }).id;
  }

  const { data: upserted, error: upsertError } = await admin
    .from("lead_replies")
    .upsert(normalized, {
      onConflict: "organization_id,instantly_message_id",
      ignoreDuplicates: false,
    })
    .select("id")
    .single();

  if (upsertError || !upserted) {
    console.error("[webhook] lead_replies upsert failed:", upsertError);
    return null;
  }

  // Always schedule the pipeline once we have content. Claude is the
  // primary classifier; the Instantly tag (instantly_category) is just a
  // hint that decide.ts merges if present. Waiting for the tag broke the
  // smoke test — the lead_* payload doesn't carry the join keys our
  // correlateTag relies on, so the tag never linked back to this row.
  return (upserted as { id: string }).id;
}
