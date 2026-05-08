// Webhook registration helper for Salesforge.
//
// Salesforge has no DELETE endpoint for webhooks (confirmed in the
// public spec at /public/v2/swagger/index.html), so registration must
// be idempotent: list every existing webhook in the workspace, dedup
// by (sequenceID, type, url), and only create the ones that are missing.
//
// We register 7 event types per sequence (the reply-routing pipeline's
// full set, defined in SALESFORGE_REPLY_PIPELINE_EVENTS in types.ts).
// We deliberately do NOT track the resulting webhook IDs locally —
// list-on-register is the source of truth.

import { SalesforgeClient } from "./client";
import {
  SALESFORGE_REPLY_PIPELINE_EVENTS,
  type SalesforgeWebhookType,
  type SalesforgeWebhook,
} from "./types";

export interface RegisterSequenceWebhooksInput {
  client: SalesforgeClient;
  workspaceId: string;
  sequenceId: string;
  // The full URL Salesforge should POST events to. Should include the
  // ?secret=<WEBHOOK_SECRET> query param so /api/webhooks/salesforge
  // can authenticate inbound payloads.
  callbackUrl: string;
  // Defaults to SALESFORGE_REPLY_PIPELINE_EVENTS. Override to register
  // a narrower set when testing.
  events?: SalesforgeWebhookType[];
  // Defaults to "LeadStart pipeline". Used as the human-readable name
  // shown in the Salesforge dashboard.
  namePrefix?: string;
}

export interface RegisterSequenceWebhooksResult {
  registered: SalesforgeWebhookType[]; // newly created in this call
  skipped: SalesforgeWebhookType[]; // already existed (dedup match)
  failed: { type: SalesforgeWebhookType; error: string }[];
}

/**
 * Register the full reply-pipeline webhook set on a Salesforge
 * sequence. Idempotent — safe to call repeatedly.
 *
 * 1. Lists all webhooks in the workspace.
 * 2. For each event type we want to subscribe to, checks whether
 *    a webhook with the same (sequenceId, type, url) tuple already
 *    exists. If yes, skip; if no, POST to create.
 *
 * Per-event failures don't abort the whole call — we collect them so
 * the caller can surface partial-success state.
 */
export async function registerSequenceWebhooks(
  input: RegisterSequenceWebhooksInput,
): Promise<RegisterSequenceWebhooksResult> {
  const {
    client,
    workspaceId,
    sequenceId,
    callbackUrl,
    events = SALESFORGE_REPLY_PIPELINE_EVENTS,
    namePrefix = "LeadStart pipeline",
  } = input;

  const existing: SalesforgeWebhook[] = await client.listWebhooks(workspaceId);

  const registered: SalesforgeWebhookType[] = [];
  const skipped: SalesforgeWebhookType[] = [];
  const failed: { type: SalesforgeWebhookType; error: string }[] = [];

  for (const eventType of events) {
    const alreadyExists = existing.some(
      (w) =>
        w.sequenceId === sequenceId &&
        w.type === eventType &&
        w.url === callbackUrl,
    );
    if (alreadyExists) {
      skipped.push(eventType);
      continue;
    }

    try {
      await client.createWebhook(workspaceId, {
        name: `${namePrefix} — ${eventType}`,
        type: eventType,
        url: callbackUrl,
        sequenceID: sequenceId,
      });
      registered.push(eventType);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ type: eventType, error: message });
    }
  }

  return { registered, skipped, failed };
}
