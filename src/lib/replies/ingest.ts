// Ingest helper — normalises an Instantly Email object (from GET /api/v2/emails/{id})
// + the triggering webhook payload into the row shape we insert into
// public.lead_replies.
//
// Pure function. No side effects. No network. The webhook-handler wiring
// that calls this lives in commit #6; this module is built first so we can
// round-trip tests against fixtures and confirm `eaccount` (the hosted
// mailbox) is captured correctly end-to-end.

import type { InstantlyEmail } from "@/lib/instantly/types";
import type { LeadReply } from "@/types/app";
import { runKeywordPrefilter, type PrefilterResult } from "./keyword-prefilter";

export interface IngestContext {
  organization_id: string;
  // NULL for orphan replies (webhook fired for a campaign we hadn't yet
  // linked to a LeadStart client). The pipeline classifies the reply but
  // skips notification until B3 links the campaign.
  client_id: string | null;
  // DB campaign id (not Instantly's). Nullable because we might receive a
  // webhook for a campaign we haven't linked yet.
  campaign_id: string | null;
}

// Raw webhook payload — preserved verbatim on raw_payload for audit /
// reclassify-training use. We don't parse it here; enrichment happens
// via GET /api/v2/emails/{id} so the InstantlyEmail has already been
// fetched by the caller.
export type RawWebhookPayload = Record<string, unknown>;

// Columns this function is responsible for populating on lead_replies.
// Anything not set here is left null/default by the caller's insert.
export type IngestedReply = Pick<
  LeadReply,
  | "organization_id"
  | "client_id"
  | "campaign_id"
  | "instantly_email_id"
  | "instantly_message_id"
  | "thread_id"
  | "instantly_campaign_id"
  | "eaccount"
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
  | "instantly_category"
  | "keyword_flags"
  | "referral_contact"
  | "status"
>;

// Extract body_text + body_html from Instantly's `body` union
// (either `{ text, html }` or a plain string).
function splitBody(body: InstantlyEmail["body"]): { text: string | null; html: string | null } {
  if (!body) return { text: null, html: null };
  if (typeof body === "string") return { text: body, html: null };
  return { text: body.text ?? null, html: body.html ?? null };
}

// Pull lead fields out of the webhook payload. Instantly's webhook body
// includes lead fields alongside the email reference (first_name,
// last_name, company_name, phone, linkedin_url, etc. — shape varies by
// event type and account configuration).
function extractLeadFieldsFromPayload(payload: RawWebhookPayload): {
  lead_name: string | null;
  lead_company: string | null;
  lead_title: string | null;
  lead_phone_e164: string | null;
  lead_linkedin_url: string | null;
} {
  const get = (k: string): string | null => {
    const v = payload[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  const first = get("first_name");
  const last = get("last_name");
  const fullName = [first, last].filter(Boolean).join(" ") || get("lead_name") || null;

  return {
    lead_name: fullName,
    lead_company: get("company_name") || get("company") || null,
    lead_title: get("title") || get("job_title") || null,
    lead_phone_e164: get("phone") || get("phone_number") || null,
    lead_linkedin_url: get("linkedin_url") || get("linkedin") || null,
  };
}

/**
 * Normalise an Instantly Email + webhook payload into a lead_replies insert.
 *
 * The critical eaccount roundtrip lives here: we copy Instantly's
 * first-class `eaccount` field directly onto lead_replies.eaccount so that
 * when the client sends a reply through the portal later, the send helper
 * pulls it back out and passes it to POST /api/v2/emails/reply.
 *
 * @param email - the enriched Email object from GET /api/v2/emails/{id}
 * @param webhookPayload - the raw webhook body that triggered the ingest
 * @param ctx - resolved organization/client/campaign the reply belongs to
 * @returns a partial lead_replies row ready to insert
 */
export function normalizeReplyFromInstantlyEmail(
  email: InstantlyEmail,
  webhookPayload: RawWebhookPayload,
  ctx: IngestContext
): IngestedReply {
  const { text: body_text, html: body_html } = splitBody(email.body);
  const leadFields = extractLeadFieldsFromPayload(webhookPayload);

  // Webhook payload usually lacks first/last name; pull the display name
  // off the email's from_address_json as a fallback so the dossier subject
  // and header don't render as "A new lead".
  if (!leadFields.lead_name && email.from_address_json?.[0]?.name) {
    leadFields.lead_name = email.from_address_json[0].name;
  }

  // Run prefilter at ingest so keyword_flags is populated even before
  // Claude runs. Commit #4's decide.ts layer will merge this with the
  // Claude classifier result.
  const prefilter: PrefilterResult = runKeywordPrefilter(body_text, email.from_address_email);

  // Referral contact extracted from prefilter. We take the first embedded
  // address for now; multi-referral edge cases get handled in commit #4.
  const referral_contact =
    prefilter.suggested_class === "referral_forward" && prefilter.embedded_emails.length > 0
      ? {
          email: prefilter.embedded_emails[0],
          name: null,
          title: null,
        }
      : null;

  // to_address: Instantly's to_address_email_list is an array; for a
  // received reply it's typically a single entry (our hosted mailbox).
  // We store the first entry for display; the authoritative hosted mailbox
  // is always `eaccount` below.
  const to_address = email.to_address_email_list?.[0] ?? null;

  // Instantly's native category comes from the lead_* webhook event that
  // tags the reply (lead_interested / lead_wrong_person / etc.). For a
  // bare reply_received event we may not have this yet; tagReply() writes
  // it later if the tag arrives after the reply.
  const rawCategory = webhookPayload.event_type;
  const instantly_category =
    typeof rawCategory === "string" && rawCategory.startsWith("lead_") ? rawCategory : null;

  return {
    organization_id: ctx.organization_id,
    client_id: ctx.client_id,
    campaign_id: ctx.campaign_id,

    instantly_email_id: email.id,
    instantly_message_id: email.message_id ?? null,
    thread_id: email.thread_id ?? null,
    instantly_campaign_id: email.campaign_id ?? null,

    // THE eaccount ROUNDTRIP — this is the hosted mailbox that received the
    // prospect's reply. Passed back to POST /emails/reply at send time.
    eaccount: email.eaccount ?? null,

    lead_email: email.from_address_email,
    lead_name: leadFields.lead_name,
    lead_company: leadFields.lead_company,
    lead_title: leadFields.lead_title,
    lead_phone_e164: leadFields.lead_phone_e164,
    lead_linkedin_url: leadFields.lead_linkedin_url,

    from_address: email.from_address_email,
    to_address,
    subject: email.subject ?? null,
    body_text,
    body_html,
    received_at: email.timestamp_email,
    raw_payload: webhookPayload,

    instantly_category,
    keyword_flags: prefilter.flags,
    referral_contact,

    status: "new",
  };
}
