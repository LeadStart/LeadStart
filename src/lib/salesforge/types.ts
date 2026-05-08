// Salesforge.ai API types (legacy / v0 surface).
//
// Salesforge has TWO sequence systems:
//   - legacy:        https://api.salesforge.ai            ← what we use
//   - multichannel:  https://multichannel-api.salesforge.ai
// We are migrating from Instantly to legacy Salesforge, so every type
// here targets the legacy host. The multichannel API is a different
// product surface and is not used in this migration.
//
// Where Salesforge's published OpenAPI spec is incomplete (most notably
// the webhook payload shape, several list-response envelopes, and the
// per-mailbox analytics surfaces), the types below cover the fields we
// actually consume in the rest of the codebase. The first cascade test
// against a real Salesforge account will surface any field-name drift;
// we tighten the types then rather than guessing now.

// ===== ME / WORKSPACES / PRODUCTS =====

// GET /me returns { accountId, apiKeyName } — the api-key-scoped account.
// (Confirmed against the live API 2026-05-07.)
export interface SalesforgeMe {
  accountId: string;
  apiKeyName?: string;
}

// Salesforge wraps list responses in a paginated envelope. SalesforgeListEnvelope
// captures the pagination fields used by every list endpoint we call.
export interface SalesforgeListEnvelope<T> {
  total: number;
  offset: number;
  limit: number;
  data: T[];
}

export interface SalesforgeWorkspace {
  id: string;
  accountId?: string;
  name: string;
  slug?: string;
}

export type SalesforgeWorkspaceList = SalesforgeListEnvelope<SalesforgeWorkspace>;

export interface SalesforgeProduct {
  id: string;
  name: string;
}

export type SalesforgeProductList = SalesforgeListEnvelope<SalesforgeProduct>;

// ===== SEQUENCES (legacy = "campaigns") =====

export interface SalesforgeSequence {
  id: string;
  name: string;
  // Salesforge uses string statuses ("active", "paused", "draft",
  // "completed"). We keep the field permissive so a future status the
  // spec adds doesn't break the client.
  status?: string;
  workspaceId?: string;
  productId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type SalesforgeSequenceList = SalesforgeListEnvelope<SalesforgeSequence>;

// GET /sequences/{id}/analytics — totals + an optional daily breakdown.
// The daily array is what powers /admin/campaigns/{id}'s area chart, so
// we map it to the existing campaign_snapshots row shape in the cron.
export interface SalesforgeAnalytics {
  sequence_id?: string;
  from_date?: string;
  to_date?: string;
  emails_sent?: number;
  emails_opened?: number;
  emails_replied?: number;
  emails_bounced?: number;
  unsubscribes?: number;
  meetings_booked?: number;
  open_rate?: number;
  reply_rate?: number;
  bounce_rate?: number;
  daily?: SalesforgeDailyAnalytics[];
}

export interface SalesforgeDailyAnalytics {
  date: string;
  sent?: number;
  opened?: number;
  replied?: number;
  bounced?: number;
  unsubscribed?: number;
  meetings_booked?: number;
}

// ===== MAILBOXES =====

export interface SalesforgeMailbox {
  id: string;
  email: string;
  // "active" | "paused" | "disconnected" — kept permissive.
  status?: string;
  dailyLimit?: number;
  workspaceId?: string;
  warmupEnabled?: boolean;
}

export type SalesforgeMailboxList = SalesforgeListEnvelope<SalesforgeMailbox>;

// ===== EMAILS =====

// Partial Email shape — covers the fields the ingest pipeline reads.
// Salesforge addresses emails by (workspace, mailbox, email_id), unlike
// Instantly which uses a flat /emails/{id} surface.
export interface SalesforgeEmail {
  id: string;
  thread_id?: string;
  mailbox_id?: string;
  workspace_id?: string;
  subject?: string;
  from_address?: string;
  from_name?: string;
  to_addresses?: string[];
  body_text?: string;
  body_html?: string;
  received_at?: string;
  // Salesforge's reply endpoint infers subject from the original email,
  // so unlike Instantly we do not pass subject on outbound replies.
}

// POST /workspaces/{ws}/mailboxes/{mb}/emails/{em}/reply request body.
// Salesforge infers the subject from the original thread, so the field
// is intentionally absent.
export interface SalesforgeReplyRequest {
  body_text: string;
  body_html?: string;
  cc_addresses?: string[];
  bcc_addresses?: string[];
}

// ===== CONTACTS =====

// POST /contacts/bulk — Salesforge caps a single request at 100 contacts.
// Callers passing larger lists must batch upstream.
export interface SalesforgeContactCreate {
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  title?: string;
  phone?: string;
  linkedin_url?: string;
  custom_variables?: Record<string, string | number | boolean | null>;
}

export interface SalesforgeContactBulkResponse {
  // Counts vary across spec mirrors; both forms are tolerated.
  created?: number;
  updated?: number;
  failed?: Array<{ email: string; error: string }>;
  contacts?: Array<{ id: string; email: string }>;
}

// PUT /sequences/{id}/contacts — associate already-created contacts
// with a sequence.
export interface SalesforgeSequenceContactsRequest {
  contact_ids: string[];
}

// ===== WEBHOOKS =====

// Webhooks register per-sequence + per-event-type. Salesforge has no
// DELETE endpoint, so registration is idempotent via GET /webhooks
// dedupe by (sequence_id, event_type, url) — see registerSequenceWebhooks
// in src/lib/salesforge/webhooks.ts (commit 3).
export type SalesforgeWebhookEvent =
  | "email_replied"
  | "positive_reply"
  | "negative_reply"
  | "email_bounced"
  | "contact_unsubscribed"
  | "dnc_added"
  | "label_changed";

export interface SalesforgeWebhookCreate {
  sequence_id: string;
  event_type: SalesforgeWebhookEvent;
  url: string;
}

export interface SalesforgeWebhook {
  id: string;
  sequenceId: string;
  // Permissive on the read side so a value the spec adds later does
  // not break the dedup helper.
  eventType: string;
  url: string;
}

export type SalesforgeWebhookList = SalesforgeListEnvelope<SalesforgeWebhook>;

// Webhook delivery payload — undocumented shape. The handler in
// src/app/api/webhooks/salesforge/route.ts uses defensive parsing
// (typeof / optional chaining) before reading any field. We treat
// this as an opaque record for now and tighten it after the cascade
// test captures a real payload.
export type SalesforgeWebhookPayload = Record<string, unknown>;
