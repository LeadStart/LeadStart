// Ingest helper — normalises a Salesforge webhook payload into the row
// shape we insert into public.lead_replies.
//
//   - No enrichment fetch. The Salesforge webhook payload is expected
//     to carry the body + lead identity inline. (Salesforge does expose
//     GET /workspaces/.../emails/{id} as a fallback, but the webhook
//     should be authoritative.)
//
//   - Dedup key is (organization_id, salesforge_email_id). Salesforge
//     does not expose RFC 5322 message-id, so we lean on their internal
//     email UUID. The unique constraint is installed by migration 00049
//     as a regular UNIQUE (not partial), so the route handler can use
//     ON CONFLICT for idempotent retries.
//
//   - Webhook payload shape is undocumented. Every field read goes
//     through pickString / pickNested with a fallback list of common
//     names. The first cascade test against a real Salesforge webhook
//     will refute or confirm; we tighten then.
//
// Pure function. No side effects. No network. The webhook handler at
// src/app/api/webhooks/salesforge/route.ts is the only caller.

import type { LeadReply } from "@/types/app";
import { runKeywordPrefilter } from "./keyword-prefilter";

export type SalesforgeWebhookPayload = Record<string, unknown>;

export interface IngestSalesforgeContext {
  organization_id: string;
  // NULL for orphan replies (webhook fired for a sequence we hadn't yet
  // linked to a LeadStart client). Pipeline classifies but skips
  // notification until B3 links the campaign.
  client_id: string | null;
  // DB campaign id (not Salesforge's). Nullable because we might receive
  // a webhook for a sequence we haven't linked yet — but in practice the
  // route handler lazy-creates the campaign before calling ingest, so
  // this is non-null at call time.
  campaign_id: string | null;
}

// Columns this function is responsible for populating on lead_replies.
// Anything not set here is left null/default by the caller's insert.
export type IngestedSalesforgeReply = Pick<
  LeadReply,
  | "organization_id"
  | "client_id"
  | "campaign_id"
  | "source_channel"
  | "salesforge_email_id"
  | "salesforge_thread_id"
  | "salesforge_mailbox_id"
  | "lead_email"
  | "lead_name"
  | "lead_company"
  | "lead_title"
  | "lead_phone_e164"
  | "lead_linkedin_url"
  | "from_address"
  | "to_address"
  | "subject"
  | "body_text"
  | "body_html"
  | "received_at"
  | "raw_payload"
  | "keyword_flags"
  | "referral_contact"
  | "status"
>;

// Defensive string getter — first key that resolves to a non-empty
// trimmed string wins; null otherwise.
function pickString(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// Defensive nested getter — walks the object path; returns the value at
// the leaf (or undefined if any step isn't a plain object).
function pickNested(
  payload: Record<string, unknown>,
  path: string[]
): unknown {
  let current: unknown = payload;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function pickStringNested(
  payload: Record<string, unknown>,
  path: string[]
): string | null {
  const value = pickNested(payload, path);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Normalise a Salesforge webhook payload into a lead_replies insert.
 *
 * Returns null if the payload is missing the minimum required fields:
 *   - salesforge_email_id (the dedup key)
 *   - lead_email (NOT NULL on lead_replies)
 *
 * The route handler logs and drops in the null case rather than
 * inserting a partial row.
 */
export function normalizeSalesforgeReplyFromWebhook(
  payload: SalesforgeWebhookPayload,
  ctx: IngestSalesforgeContext
): IngestedSalesforgeReply | null {
  // Required: dedup key + NOT NULL lead_email.
  const salesforge_email_id =
    pickString(payload, "email_id", "id", "message_id", "salesforge_email_id") ??
    pickStringNested(payload, ["email", "id"]) ??
    pickStringNested(payload, ["message", "id"]);

  const lead_email =
    pickString(
      payload,
      "lead_email",
      "from_email",
      "from_address",
      "contact_email",
      "email"
    ) ??
    pickStringNested(payload, ["contact", "email"]) ??
    pickStringNested(payload, ["lead", "email"]);

  if (!salesforge_email_id || !lead_email) return null;

  const salesforge_thread_id =
    pickString(payload, "thread_id", "conversation_id", "salesforge_thread_id") ??
    pickStringNested(payload, ["email", "thread_id"]);

  const salesforge_mailbox_id =
    pickString(payload, "mailbox_id", "from_mailbox_id", "salesforge_mailbox_id") ??
    pickStringNested(payload, ["email", "mailbox_id"]) ??
    pickStringNested(payload, ["mailbox", "id"]);

  const first_name =
    pickString(payload, "first_name", "contact_first_name") ??
    pickStringNested(payload, ["contact", "first_name"]);
  const last_name =
    pickString(payload, "last_name", "contact_last_name") ??
    pickStringNested(payload, ["contact", "last_name"]);
  const fallbackFullName = pickString(
    payload,
    "lead_name",
    "contact_name",
    "from_name"
  );
  const lead_name =
    [first_name, last_name].filter(Boolean).join(" ").trim() || fallbackFullName;

  const subject =
    pickString(payload, "subject", "email_subject") ??
    pickStringNested(payload, ["email", "subject"]);

  const body_text =
    pickString(payload, "body_text", "body", "text", "message_text") ??
    pickStringNested(payload, ["email", "body_text"]) ??
    pickStringNested(payload, ["email", "body"]);

  const body_html =
    pickString(payload, "body_html", "html", "message_html") ??
    pickStringNested(payload, ["email", "body_html"]);

  const received_at =
    pickString(
      payload,
      "received_at",
      "received_at_utc",
      "timestamp",
      "sent_at",
      "created_at"
    ) ??
    pickStringNested(payload, ["email", "received_at"]) ??
    new Date().toISOString();

  const from_address =
    pickString(payload, "from_address", "from_email") ??
    pickStringNested(payload, ["email", "from_address"]);

  const to_address =
    pickString(payload, "to_address", "to_email") ??
    pickStringNested(payload, ["email", "to_address"]);

  // Run prefilter at ingest so keyword_flags is populated before Claude
  // runs.
  const prefilter = runKeywordPrefilter(body_text, lead_email);

  const referral_contact =
    prefilter.suggested_class === "referral_forward" &&
    prefilter.embedded_emails.length > 0
      ? { email: prefilter.embedded_emails[0], name: null, title: null }
      : null;

  return {
    organization_id: ctx.organization_id,
    client_id: ctx.client_id,
    campaign_id: ctx.campaign_id,
    source_channel: "salesforge",

    salesforge_email_id,
    salesforge_thread_id,
    salesforge_mailbox_id,

    lead_email,
    lead_name,
    lead_company:
      pickString(payload, "company", "company_name", "lead_company") ??
      pickStringNested(payload, ["contact", "company"]),
    lead_title:
      pickString(payload, "title", "job_title", "lead_title") ??
      pickStringNested(payload, ["contact", "title"]),
    lead_phone_e164:
      pickString(payload, "phone", "phone_number", "lead_phone") ??
      pickStringNested(payload, ["contact", "phone"]),
    lead_linkedin_url:
      pickString(payload, "linkedin_url", "linkedin", "lead_linkedin_url") ??
      pickStringNested(payload, ["contact", "linkedin_url"]),

    from_address: from_address ?? lead_email,
    to_address,
    subject,
    body_text,
    body_html,
    received_at,
    raw_payload: payload,

    keyword_flags: prefilter.flags,
    referral_contact,

    status: "new",
  };
}
