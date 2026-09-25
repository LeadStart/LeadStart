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
import type { NativeBounceClass } from "@/types/app";

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
  /** Machine-readable bounce fields (all null / empty on ordinary mail). */
  dsn: DsnDetails;
}

/**
 * The machine-readable half of a bounce notice (RFC 3464), plus the ids of the
 * message that bounced.
 *
 * WHERE GMAIL PUTS IT (verified against the real notices in our sending
 * mailboxes, 2026-09-25): the Gmail API never returns a message/delivery-status
 * part with a body of its own. It splits that part into child parts and hands
 * the DSN fields back as the CHILDREN'S HEADERS and/or the children's body
 * text:
 *   Gmail "(Failure)" / "(Delay)": per-message fields (Reporting-MTA,
 *     X-Original-Message-ID) as child headers; per-recipient fields
 *     (Final-Recipient, Action, Status, Diagnostic-Code) as child body text.
 *   Mimecast / Microsoft 365 "Your message couldn't be delivered": every field
 *     as a child header, no body, and "Final-Recipient: rfc/822;..." (sic).
 * The old parser read only the part's own body, so it found nothing on every
 * real notice and each one fell through to subject/body guessing, which
 * misread final "(Failure)" notices that quote a 4.x.x code as soft.
 */
export interface DsnDetails {
  /** failed | delayed | delivered | relayed | expanded */
  action: string | null;
  /** Enhanced status code: the Status field, or the Diagnostic-Code's own code
   *  when Status is a generic x.0.0 (Mimecast: 5.0.0 hiding a 5.4.1). */
  status: string | null;
  /** The receiving server's explanation (Diagnostic-Code, unfolded). */
  diagnostic: string | null;
  finalRecipient: string | null;
  originalRecipient: string | null;
  /**
   * Message-IDs naming the message that bounced, case preserved, most exact
   * first: X-Original-Message-ID and the returned original headers
   * (text/rfc822-headers, or an attached message/rfc822), then the notice's
   * own In-Reply-To, then its References. Attributes a bounce to the exact
   * send (and step) even when the notice lands on a thread of its own.
   */
  originalMessageIds: string[];
}

const ENHANCED_CODE_RE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;
const MESSAGE_ID_RE = /<[^<>\s]+@[^<>\s]+>/g;

// "Name: value" lines, with RFC 5322 folded continuation lines joined first.
function fieldLines(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/);
    if (m) out.push([m[1].toLowerCase(), m[2].trim()]);
  }
  return out;
}

// First part of a given type anywhere in the tree, with or without a body.
function findPartByType(
  part: GmailPayloadPart | undefined,
  mimeType: string,
): GmailPayloadPart | null {
  if (!part) return null;
  if (part.mimeType === mimeType) return part;
  for (const child of part.parts ?? []) {
    const found = findPartByType(child, mimeType);
    if (found) return found;
  }
  return null;
}

// "rfc822; a@b.com", "rfc822;<a@b.com>", "rfc/822;a@b.com" (Mimecast) or bare.
function dsnAddress(value: string | undefined): string | null {
  if (!value) return null;
  const v = value
    .replace(/^[a-z0-9/.-]+\s*;\s*/i, "")
    .replace(/[<>]/g, "")
    .trim()
    .toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(v) ? v : null;
}

function readDsn(
  payload: GmailPayloadPart | undefined,
  headers: Record<string, string>,
): DsnDetails {
  // Every DSN field under the message/delivery-status subtree: the children's
  // headers (minus MIME plumbing) and the children's decoded body lines.
  const fields: [string, string][] = [];
  const ds = findPartByType(payload, "message/delivery-status");
  if (ds) {
    const walk = (p: GmailPayloadPart, isRoot: boolean) => {
      if (!isRoot) {
        for (const h of (p.headers ?? []) as GmailHeader[]) {
          const name = h.name.toLowerCase();
          if (!name.startsWith("content-")) fields.push([name, h.value.trim()]);
        }
      }
      if (p.body?.data) fields.push(...fieldLines(decodeB64Url(p.body.data)));
      for (const c of p.parts ?? []) walk(c, false);
    };
    walk(ds, true);
  }
  const first = (name: string) => fields.find(([k]) => k === name)?.[1];

  const diagnostic = first("diagnostic-code")?.replace(/^smtp\s*;\s*/i, "").trim() || null;
  const statusField = first("status")?.match(ENHANCED_CODE_RE)?.[0] ?? null;
  const diagnosticCode = diagnostic?.match(ENHANCED_CODE_RE)?.[0] ?? null;
  const status =
    statusField && /\.0\.0$/.test(statusField) && diagnosticCode && diagnosticCode[0] === statusField[0]
      ? diagnosticCode
      : statusField ?? diagnosticCode;

  const ids: string[] = [];
  const addIds = (v: string | undefined | null) => {
    for (const id of v?.match(MESSAGE_ID_RE) ?? []) if (!ids.includes(id)) ids.push(id);
  };
  for (const [k, v] of fields) {
    if (k === "x-original-message-id" || k === "original-message-id") addIds(v);
  }
  // Returned original headers: Gmail attaches text/rfc822-headers; Exchange
  // attaches the whole message/rfc822, whose headers Gmail puts on its child.
  // Only the original's own Message-ID: its In-Reply-To/References would point
  // at the previous step, not the one that bounced.
  const walkReturned = (p: GmailPayloadPart | undefined) => {
    if (!p) return;
    if (p.mimeType === "text/rfc822-headers" && p.body?.data) {
      for (const [k, v] of fieldLines(decodeB64Url(p.body.data))) if (k === "message-id") addIds(v);
    }
    if (p.mimeType === "message/rfc822") {
      for (const c of p.parts ?? []) {
        for (const h of (c.headers ?? []) as GmailHeader[]) {
          if (h.name.toLowerCase() === "message-id") addIds(h.value);
        }
      }
      if (p.body?.data) {
        for (const [k, v] of fieldLines(decodeB64Url(p.body.data))) if (k === "message-id") addIds(v);
      }
    }
    for (const c of p.parts ?? []) walkReturned(c);
  };
  walkReturned(payload);
  addIds(headers["in-reply-to"]);
  // References lists the oldest message first; newest first here so the direct
  // parent (the message that bounced) outranks earlier steps of the thread.
  for (const id of [...(headers["references"]?.match(MESSAGE_ID_RE) ?? [])].reverse()) {
    if (!ids.includes(id)) ids.push(id);
  }

  return {
    action: first("action")?.toLowerCase() ?? null,
    status,
    diagnostic,
    finalRecipient: dsnAddress(first("final-recipient")),
    originalRecipient: dsnAddress(first("original-recipient")),
    originalMessageIds: ids,
  };
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
    dsn: readDsn(msg.payload, headers),
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
  // Exchange / Microsoft 365 stamps every non-delivery report it generates.
  if ("x-ms-exchange-message-is-ndr" in parsed.headers) return true;
  const contentType = (parsed.headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("multipart/report")) return true;
  const subject = (parsed.subject ?? "").toLowerCase();
  if (FAILURE_SUBJECT_RE.test(subject) || DELAY_SUBJECT_RE.test(subject)) return true;
  return false;
}

// Subject wording, used only when a notice carries no Action field. Anchored
// at the start: Exchange-style subjects append OUR subject after the status
// word ("Undeliverable: <our subject>"), so an unanchored match could read a
// word from our own copy.
const DELAY_SUBJECT_RE =
  /^\s*(delivery status notification \(delay\)|delivery delayed|warning: message delayed|message delayed|delayed mail)/i;
const FAILURE_SUBJECT_RE =
  /^\s*(delivery status notification \(failure\)|undeliverable|undelivered mail|(your )?message( to \S+)? (couldn['’]?t|could not|can['’]?t|cannot|wasn['’]?t|was not) (be )?delivered|delivery (has )?failed|mail delivery failed|mail delivery subsystem|returned mail|failure notice|address not found|message not delivered|message blocked)/i;

export type BounceSeverity = "hard" | "soft" | "none";

export interface BounceVerdict {
  /** hard = final, suppress; soft = transient, retrying; none = not a failure. */
  severity: BounceSeverity;
  /** Enhanced status code from the DSN fields (or, failing that, the notice text). */
  code: string | null;
  /** What a hard bounce means. Null unless severity is "hard". */
  bounceClass: NativeBounceClass | null;
  /** The receiving server's own explanation, trimmed. Null unless hard. */
  diagnostic: string | null;
}

/**
 * Classify a bounce notice. The machine-readable Action field decides when
 * present: "failed" is FINAL even when the last error was a 4.x.x (the sender
 * ran out of retries: a Gmail "(Failure)" notice after days of "(Delay)"
 * notices carries the last transient code, and reading that code as soft kept
 * mailing an unreachable address for its whole sequence). Without an Action:
 * the subject wording, then the status code, then hard (an unparseable
 * in-thread notice is usually final). Only hard bounces suppress a contact.
 */
export function classifyBounce(parsed: ParsedGmailMessage): BounceVerdict {
  const { dsn } = parsed;
  const subject = parsed.subject ?? "";
  // Without a Diagnostic-Code, fall back to the notice's lines that carry an
  // SMTP / enhanced status code. Never the whole body: an attached copy of our
  // own email would put our copy's words into the classifier.
  const reason =
    dsn.diagnostic ??
    (parsed.bodyText
      .split(/\r?\n/)
      .filter((l) => ENHANCED_CODE_RE.test(l) || /\b[45]\d\d[ -]/.test(l))
      .join(" ")
      .slice(0, 2000) || null);
  const code = dsn.status ?? reason?.match(ENHANCED_CODE_RE)?.[0] ?? null;

  let severity: BounceSeverity;
  if (dsn.action === "delayed") severity = "soft";
  else if (dsn.action === "failed") severity = "hard";
  else if (dsn.action === "delivered" || dsn.action === "relayed" || dsn.action === "expanded") severity = "none";
  else if (DELAY_SUBJECT_RE.test(subject)) severity = "soft";
  else if (FAILURE_SUBJECT_RE.test(subject)) severity = "hard";
  else if (code?.startsWith("4.")) severity = "soft";
  else severity = "hard";

  if (severity !== "hard") return { severity, code, bounceClass: null, diagnostic: null };
  const diagnostic = (reason ?? subject).replace(/\s+/g, " ").trim().slice(0, 500) || null;
  return { severity, code, bounceClass: bounceClassFor(code, reason ?? ""), diagnostic };
}

/**
 * What a hard bounce means, from its status code + the server's explanation.
 * Order matters: the specific explanations are tested before the broad code
 * families (Microsoft's "5.4.1 Recipient address rejected" is a dead address;
 * its "unauthenticated ... no mail-enabled subscriptions" is a recipient
 * domain with no mail service, not an authentication failure; a Gmail 5.7.26
 * mentions "spam" but is an authentication rejection).
 */
export function bounceClassFor(code: string | null, reasonText: string): NativeBounceClass {
  const r = reasonText.toLowerCase();
  const family = code?.split(".")[1];
  if (/no mail-enabled subscriptions|hosted tenant/.test(r)) return "unreachable";
  if (
    family === "1" ||
    /recipient ?not ?found|recipient address rejected|user unknown|unknown user|no such (user|recipient|mailbox)|does ?n['’]?o?t exist|address not found|invalid recipient|mailbox not found|not found by smtp address lookup/.test(r)
  ) {
    return "invalid_address";
  }
  if (family === "2" || /mailbox (is )?full|over quota|quota exceeded|insufficient storage|(mailbox|account) (is |has been )?(disabled|inactive|suspended)/.test(r)) {
    return "mailbox_unavailable";
  }
  if (
    /^5\.7\.(2[3-7]|509|515)$/.test(code ?? "") ||
    /unauthenticated|authentication (fail|check|required|information)|\b(spf|dkim|dmarc)\b[^.;]{0,40}\b(fail|failed|failure|reject|rejected)\b|dmarc policy/.test(r)
  ) {
    return "auth_failure";
  }
  if (
    code === "5.7.350" ||
    /spam|suspicious|reputation|unsolicited|block ?list|black ?list|dnsbl|\brbl\b|spamhaus|spamcop|phish|malicious|banned sending|bulk mail|content (was )?rejected/.test(r)
  ) {
    return "spam_block";
  }
  if (code?.startsWith("5.7")) return "policy_block";
  if (
    code?.startsWith("4.") ||
    family === "4" ||
    /timed out|did not accept our requests|connection (refused|timed out|reset)|no mx|dns (error|failure|lookup)|domain (not found|does not exist)|host (not found|unknown)|unrout(e)?able/.test(r)
  ) {
    return "unreachable";
  }
  return "other";
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
 * Best-effort failed-recipient extraction from a DSN. Original-Recipient
 * first: on a forwarding failure Final-Recipient is the forward target, while
 * Original-Recipient is the address WE sent to. Then X-Failed-Recipients (set
 * by Gmail's own notices), then Final-Recipient, then a Final-Recipient line
 * in the body text. Null when none is present: the caller then relies on the
 * original Message-ID or the thread.
 */
export function extractFailedRecipient(parsed: ParsedGmailMessage): string | null {
  if (parsed.dsn.originalRecipient) return parsed.dsn.originalRecipient;
  const header = parsed.headers["x-failed-recipients"];
  const fromHeader = header?.split(",")[0].trim().toLowerCase();
  if (fromHeader) return fromHeader;
  if (parsed.dsn.finalRecipient) return parsed.dsn.finalRecipient;
  const finalRecipient = parsed.bodyText.match(
    /Final-Recipient:\s*rfc\/?822\s*;\s*<?([^\s<>;]+@[^\s<>;]+)>?/i,
  );
  if (finalRecipient) return finalRecipient[1].trim().toLowerCase();
  return null;
}
