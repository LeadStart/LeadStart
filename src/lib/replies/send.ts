// Build the POST /api/v2/emails/reply request body from a stored LeadReply.
//
// This is the OTHER HALF of the eaccount roundtrip. Ingest wrote
// `eaccount` from the Instantly Email object into lead_replies;
// this function reads it back out and hands it to the reply API.
//
// Pure function. The HTTP call lives on InstantlyClient.replyViaEmailsApi.

import type { LeadReply } from "@/types/app";
import type { InstantlyReplyRequest } from "@/lib/instantly/types";

export interface BuildReplyInput {
  // The stored reply we're responding to
  reply: Pick<
    LeadReply,
    "eaccount" | "instantly_email_id" | "subject" | "body_text"
  >;
  // Body of the client's outgoing reply (final, after edit)
  body_text: string;
  body_html?: string;
  // Subject override. If omitted, we re-use the original prefixed with "Re:"
  // (Instantly typically threads by message-id + subject match).
  subject?: string;
  // Client's notification email — auto-CC'd on every send so the thread
  // lives in the client's inbox. The only CC by default; more can be added
  // via the portal before send.
  cc_addresses?: string[];
  bcc_addresses?: string[];
}

export class MissingReplyFieldError extends Error {
  constructor(public field: "eaccount" | "instantly_email_id") {
    super(`Cannot send reply: lead_replies.${field} is null.`);
    this.name = "MissingReplyFieldError";
  }
}

/**
 * Construct the exact request body Instantly expects for POST /emails/reply.
 * Throws on missing required fields rather than silently producing an
 * invalid payload.
 *
 * @param input - the stored reply + the client's composed body
 * @returns an InstantlyReplyRequest ready to pass to
 *   `InstantlyClient.replyViaEmailsApi`.
 */
export function buildReplyRequest(input: BuildReplyInput): InstantlyReplyRequest {
  const { reply, body_text, body_html, subject, cc_addresses, bcc_addresses } = input;

  if (!reply.eaccount) {
    throw new MissingReplyFieldError("eaccount");
  }
  if (!reply.instantly_email_id) {
    throw new MissingReplyFieldError("instantly_email_id");
  }

  // Default subject: re-use the original with "Re:" prefix. We keep it even
  // when the inbound subject already started with "Re:" (Gmail etc. dedupe
  // leading Re: chains; a defensive strip is unnecessary and can break
  // legitimate subjects containing "Re:" as a real word).
  const originalSubject = reply.subject || "";
  const resolvedSubject =
    subject?.trim() ||
    (originalSubject.startsWith("Re:") ? originalSubject : `Re: ${originalSubject}`.trim());

  const request: InstantlyReplyRequest = {
    eaccount: reply.eaccount,
    reply_to_uuid: reply.instantly_email_id,
    subject: resolvedSubject,
    body: {
      text: body_text,
      ...(body_html ? { html: body_html } : {}),
    },
  };

  if (cc_addresses && cc_addresses.length > 0) {
    request.cc_address_email_list = cc_addresses.join(",");
  }
  if (bcc_addresses && bcc_addresses.length > 0) {
    request.bcc_address_email_list = bcc_addresses.join(",");
  }

  return request;
}
