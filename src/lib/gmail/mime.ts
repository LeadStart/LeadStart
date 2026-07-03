// Plain-text RFC 5322 builder + inbound Gmail message parser for the
// native email channel. Pure functions, no network — same style as
// src/lib/replies/ingest-salesforge.ts and keyword-prefilter.ts.
//
// Deliverability-first: we build plain-text-only messages (no HTML part,
// no tracking pixel, no rewritten links) and append NOTHING to the body —
// any opt-out language lives in the sequence copy the operator writes.

import { randomUUID } from "node:crypto";
import type { GmailMessage, GmailPayloadPart, GmailHeader } from "./client";

export interface BuildEmailParams {
  fromEmail: string;
  fromName?: string | null;
  to: string;
  /** Optional CC recipients (e.g. the client's notification inbox on a portal reply). */
  cc?: string[];
  subject: string;
  bodyText: string;
  /** RFC 5322 Message-ID we mint before sending, e.g. "<uuid@domain>". */
  messageId: string;
  /** Follow-up threading: the previous send's Message-ID. */
  inReplyTo?: string | null;
  /** Full References chain (space-joined Message-IDs) for follow-ups. */
  references?: string | null;
}

/** Mint a Message-ID scoped to the sending mailbox's domain. */
export function generateMessageId(mailboxEmail: string): string {
  const domain = mailboxEmail.includes("@")
    ? mailboxEmail.split("@")[1]
    : "leadstart.local";
  return `<${randomUUID()}@${domain}>`;
}

// RFC 2047 encode a header value when it contains non-ASCII, so display
// names and subjects with accents/emoji survive transport.
function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatFrom(email: string, name?: string | null): string {
  if (!name) return email;
  return `${encodeHeaderWord(name)} <${email}>`;
}

// Base64-encode the body wrapped at 76 chars/CRLF. Guarantees RFC 5322
// line-length compliance and clean UTF-8 regardless of paragraph length.
function base64Body(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build a plain-text email and return it base64url-encoded, ready to hand
 * to GmailClient.sendMessage(). Adds In-Reply-To/References only when
 * threading a follow-up.
 */
export function buildRawEmail(params: BuildEmailParams): string {
  const headers: string[] = [
    `From: ${formatFrom(params.fromEmail, params.fromName)}`,
    `To: ${params.to}`,
    ...(params.cc && params.cc.length > 0 ? [`Cc: ${params.cc.join(", ")}`] : []),
    `Subject: ${encodeHeaderWord(params.subject)}`,
    `Message-ID: ${params.messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
  ];
  if (params.inReplyTo) headers.push(`In-Reply-To: ${params.inReplyTo}`);
  if (params.references) headers.push(`References: ${params.references}`);

  const raw = `${headers.join("\r\n")}\r\n\r\n${base64Body(params.bodyText)}`;
  return base64url(raw);
}

// ---------- Inbound parsing ----------

export interface ParsedGmailMessage {
  headers: Record<string, string>; // lowercased header name → value
  from: string | null;
  to: string | null;
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  bodyText: string;
  bodyHtml: string | null;
  internalDateMs: number | null;
}

function decodeB64Url(data: string): string {
  return Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}

function collectHeaders(part: GmailPayloadPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of (part?.headers ?? []) as GmailHeader[]) {
    // Last-wins is fine; these headers don't legitimately repeat for our use.
    out[h.name.toLowerCase()] = h.value;
  }
  return out;
}

// Depth-first search for the first part of a given mimeType with body data.
function findPart(
  part: GmailPayloadPart | undefined,
  mimeType: string,
): GmailPayloadPart | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

// Minimal HTML → text so an HTML-only reply doesn't yield an empty
// body_text (which would make the classifier skip it forever, since no
// webhook re-fires for the native channel).
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseGmailMessage(msg: GmailMessage): ParsedGmailMessage {
  const headers = collectHeaders(msg.payload);

  const plainPart = findPart(msg.payload, "text/plain");
  const htmlPart = findPart(msg.payload, "text/html");
  const bodyHtml = htmlPart?.body?.data ? decodeB64Url(htmlPart.body.data) : null;
  let bodyText = plainPart?.body?.data ? decodeB64Url(plainPart.body.data) : "";
  if (!bodyText && bodyHtml) bodyText = stripHtml(bodyHtml);
  // Some single-part messages carry the body on payload.body directly.
  if (!bodyText && msg.payload?.body?.data && !msg.payload.parts) {
    bodyText = decodeB64Url(msg.payload.body.data);
  }

  return {
    headers,
    from: headers["from"] ?? null,
    to: headers["to"] ?? null,
    subject: headers["subject"] ?? null,
    messageId: headers["message-id"] ?? null,
    inReplyTo: headers["in-reply-to"] ?? null,
    references: headers["references"] ?? null,
    bodyText,
    bodyHtml,
    internalDateMs: msg.internalDate ? Number(msg.internalDate) : null,
  };
}

// ---------- Bounce / auto-reply detection ----------

/**
 * True if the message looks like a delivery-status notification (bounce).
 * Checks the classic DSN signals: mailer-daemon/postmaster sender, an
 * X-Failed-Recipients header, a multipart/report container, or an
 * unmistakable failure subject.
 */
export function isBounce(parsed: ParsedGmailMessage): boolean {
  const from = (parsed.from ?? "").toLowerCase();
  if (/mailer-daemon|postmaster/.test(from)) return true;
  if (parsed.headers["x-failed-recipients"]) return true;
  const contentType = (parsed.headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("multipart/report")) return true;
  const subject = (parsed.subject ?? "").toLowerCase();
  if (
    /^(mail delivery (failed|subsystem)|undeliverable|delivery status notification|returned mail|failure notice|address not found)/.test(
      subject,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Bounce severity from the DSN status code in the body. 5.x.x = permanent
 * (hard), 4.x.x = transient (soft). Gmail retries soft failures itself and
 * only surfaces a persistent one as a later hard DSN, so an unparseable
 * in-thread DSN is treated as hard (conservative — it's usually final).
 * Only hard bounces should suppress a contact; soft bounces are ignored.
 */
export function bounceSeverity(parsed: ParsedGmailMessage): "hard" | "soft" {
  if (/\b5\.\d+\.\d+\b/.test(parsed.bodyText)) return "hard";
  if (/\b4\.\d+\.\d+\b/.test(parsed.bodyText)) return "soft";
  return "hard";
}

/**
 * True for auto-generated mail (out-of-office, vacation responders). Used
 * to gate stop-on-reply so an OOO doesn't halt a sequence. Follows RFC 3834
 * (Auto-Submitted) plus the common vendor headers.
 */
export function isAutoSubmitted(parsed: ParsedGmailMessage): boolean {
  const autoSubmitted = (parsed.headers["auto-submitted"] ?? "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (parsed.headers["x-autoreply"]) return true;
  if (parsed.headers["x-autorespond"]) return true;
  // Precedence is non-standard; different servers write "auto_reply" or
  // "auto-reply" — normalize the separator so both match.
  const precedence = (parsed.headers["precedence"] ?? "").toLowerCase().replace(/-/g, "_");
  if (precedence === "auto_reply") return true;
  return false;
}

/**
 * Best-effort failed-recipient extraction from a DSN. Tries the
 * X-Failed-Recipients header, then a Final-Recipient line in the body.
 * Returns null when neither is present (caller falls back to thread match).
 */
export function extractFailedRecipient(parsed: ParsedGmailMessage): string | null {
  const header = parsed.headers["x-failed-recipients"];
  if (header) return header.split(",")[0].trim().toLowerCase() || null;
  const finalRecipient = parsed.bodyText.match(
    /Final-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i,
  );
  if (finalRecipient) return finalRecipient[1].trim().toLowerCase();
  return null;
}
