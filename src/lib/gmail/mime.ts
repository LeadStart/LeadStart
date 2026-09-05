// Plain-text RFC 5322 builder + inbound Gmail message parser for the
// native email channel. Pure functions, no network, same style as
// src/lib/replies/keyword-prefilter.ts.
//
// Deliverability-first: NO tracking pixel, NO rewritten links, NO HTML part,
// and we append NOTHING to the body. Any opt-out language lives in the
// sequence copy.
//
// We send a SINGLE text/plain part. A cold email should be byte-for-byte the
// shape of something a human typed in Gmail, and a multipart/alternative
// carrying an HTML twin is a machine-generated tell that a hand-written note
// never has.
//
// The catch this replaces: a naive plain-text send hard-wraps. Gmail honours
// the literal newlines in a text/plain body and ignores RFC 3676
// format=flowed, so pre-wrapped lines render as a narrow column on wide
// screens and double-wrap on phones. The fix is the transfer encoding, not an
// HTML part: quoted-printable (RFC 2045) lets one long logical paragraph be
// split across physical lines with soft breaks that the client removes on
// decode, handing Gmail a single long line that reflows to the reader's
// viewport. See toQuotedPrintable below.

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
  const encoded = encodeHeaderWord(name);
  // An ASCII display name is emitted as a bare phrase, which RFC 5322 only
  // allows for atext + dots. "Smith, John", "Bob (LeadStart)" or a name with a
  // colon/semicolon/angle bracket must be a quoted-string or the header parses
  // as a group / second address (SEND_RUNTIME_AUDIT.md SEND-22). Encoded
  // words (non-ASCII) are already safe as a phrase and are never quoted.
  if (encoded === name && /[^A-Za-z0-9!#$%&'*+\-/=?^_`{|}~. ]/.test(name)) {
    return `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}" <${email}>`;
  }
  return `${encoded} <${email}>`;
}

// Header values that are NOT RFC 2047-encoded (To/Cc/In-Reply-To/References)
// must never contain CR/LF or other control chars: a smuggled CRLF would
// inject arbitrary headers (e.g. Bcc:) into the raw message. Contact emails
// are validated at import, but recipients also arrive from other paths
// (portal reply CC lists, historical rows), so strip at the sink too.
// Subject and From display-name are already safe: encodeHeaderWord base64-
// encodes any value containing chars outside \x20-\x7E, which includes CRLF.
function sanitizeAddrHeader(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, "").trim();
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * RFC 2045 quoted-printable, tuned for reflowable cold-email bodies.
 *
 * Every LOGICAL line of the body stays one logical line on the wire. When it
 * exceeds the physical-line limit it is split with a SOFT break (a trailing
 * "=" before the CRLF) which the receiving client removes on decode. Gmail
 * therefore reassembles each paragraph into one long line and wraps it to the
 * reader's viewport, instead of rendering our pre-wrapped narrow column.
 *
 * Blank lines pass through untouched, so paragraph breaks survive.
 *
 * Exported for scripts/test-mime-quoted-printable.ts.
 */
export function toQuotedPrintable(text: string): string {
  // 72, not 75: protectTrailing() can turn a trailing space into "=20" (+2)
  // and a soft break appends "=" (+1), so even the worst case lands at 75,
  // inside the RFC 2045 ceiling of 76 chars per physical line.
  const MAX = 72;

  const hex = (b: number) => `=${b.toString(16).toUpperCase().padStart(2, "0")}`;

  // Space and tab pass through; a trailing one is fixed up by protectTrailing.
  const encodeChar = (ch: string): string => {
    if (ch === " " || ch === "\t") return ch;
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 33 && code <= 126 && ch !== "=") return ch;
    return Array.from(Buffer.from(ch, "utf8"), hex).join("");
  };

  // RFC 2045 rule 3: whitespace may not be the last thing on an encoded line,
  // because a decoder is allowed to strip it. Encode it instead of dropping it.
  const protectTrailing = (line: string): string => {
    if (line.endsWith(" ")) return `${line.slice(0, -1)}=20`;
    if (line.endsWith("\t")) return `${line.slice(0, -1)}=09`;
    return line;
  };

  const out: string[] = [];
  for (const logical of text.replace(/\r\n/g, "\n").split("\n")) {
    // Array.from walks the string by code point, so surrogate pairs (emoji)
    // reach encodeChar whole and encode to their real UTF-8 bytes.
    const tokens = Array.from(logical, encodeChar);
    // "From " opening a line gets rewritten by mbox-style stores; the standard
    // dodge is to encode the F so the raw text never matches.
    if (logical.startsWith("From ")) tokens[0] = "=46";

    let line = "";
    for (const tok of tokens) {
      if (line.length + tok.length > MAX) {
        out.push(`${protectTrailing(line)}=`);
        line = "";
      }
      line += tok;
    }
    out.push(protectTrailing(line));
  }
  return out.join("\r\n");
}

/**
 * Build a SINGLE-PART text/plain email, quoted-printable encoded and
 * base64url-wrapped, ready for GmailClient.sendMessage(). Adds
 * In-Reply-To/References only when threading a follow-up.
 *
 * There is deliberately no HTML alternative: see the header comment.
 */
export function buildRawEmail(params: BuildEmailParams): string {
  const headers: string[] = [
    `From: ${formatFrom(sanitizeAddrHeader(params.fromEmail), params.fromName)}`,
    `To: ${sanitizeAddrHeader(params.to)}`,
    ...(params.cc && params.cc.length > 0
      ? [`Cc: ${params.cc.map(sanitizeAddrHeader).join(", ")}`]
      : []),
    `Subject: ${encodeHeaderWord(params.subject)}`,
    `Message-ID: ${params.messageId}`,
    // RFC 5322 date-time with a numeric zone; toUTCString()'s "GMT" is the
    // obsolete obs-zone form (SEND-27).
    `Date: ${new Date().toUTCString().replace(/ GMT$/, " +0000")}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
  ];
  if (params.inReplyTo) headers.push(`In-Reply-To: ${sanitizeAddrHeader(params.inReplyTo)}`);
  if (params.references) headers.push(`References: ${sanitizeAddrHeader(params.references)}`);

  return base64url(
    `${headers.join("\r\n")}\r\n\r\n${toQuotedPrintable(params.bodyText)}`,
  );
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
  /** From a message/delivery-status part when present: "failed" | "delayed" | ... */
  dsnAction: string | null;
  /** From the same part: the enhanced status code, e.g. "5.1.1" or "4.4.1". */
  dsnStatus: string | null;
}

// Pull Action:/Status: out of a DSN's machine-readable part. Gmail hands the
// part back base64url-encoded like any other; a bounce with no such part
// yields nulls and the caller falls back to the human-readable text.
function parseDeliveryStatus(
  part: GmailPayloadPart | null,
): { action: string | null; status: string | null } {
  if (!part?.body?.data) return { action: null, status: null };
  const text = decodeB64Url(part.body.data);
  const action = text.match(/^Action:\s*([a-z-]+)/im)?.[1]?.toLowerCase() ?? null;
  const status = text.match(/^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im)?.[1] ?? null;
  return { action, status };
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

  const dsn = parseDeliveryStatus(findPart(msg.payload, "message/delivery-status"));

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
    dsnAction: dsn.action,
    dsnStatus: dsn.status,
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
 * in-thread DSN is treated as hard (conservative, it's usually final).
 * Only hard bounces should suppress a contact; soft bounces are ignored.
 */
export function bounceSeverity(parsed: ParsedGmailMessage): "hard" | "soft" {
  // The machine-readable part is authoritative when present (SEND-08): a
  // "delayed" action or a 4.x.x status is transient however the human text
  // is worded, and Gmail's "Delivery Status Notification (Delay)" notices
  // used to read as HARD because their text part carries no code.
  if (parsed.dsnAction === "delayed" || parsed.dsnAction === "relayed" || parsed.dsnAction === "expanded") {
    return "soft";
  }
  if (parsed.dsnStatus?.startsWith("5.")) return "hard";
  if (parsed.dsnStatus?.startsWith("4.")) return "soft";
  if (/\bdelay/i.test(parsed.subject ?? "")) return "soft";
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
  // Exchange / Microsoft 365 out-of-office and auto-acks (RFC 3834 is optional
  // there). Any value means "this is automated mail".
  if (parsed.headers["x-auto-response-suppress"]) return true;
  // Precedence is non-standard; different servers write "auto_reply" or
  // "auto-reply": normalize the separator so both match. bulk / junk / list
  // are the values legacy responders and help-desk auto-acks set; a THREAD-
  // MATCHED message with them is never a human reply (SEND-03).
  const precedence = (parsed.headers["precedence"] ?? "").toLowerCase().replace(/-/g, "_");
  if (precedence === "auto_reply" || precedence === "bulk" || precedence === "junk" || precedence === "list") {
    return true;
  }
  // Last resort for responders that set no header at all: the subject line.
  const subject = (parsed.subject ?? "").trim().toLowerCase();
  if (/^(automatic reply|auto(matic|mated)?[ -]?(reply|response)|out of (the )?office|ooo\b|autoreply)/.test(subject)) {
    return true;
  }
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
