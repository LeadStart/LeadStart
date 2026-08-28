// Hand-rolled Gmail API client using a Google service account with
// domain-wide delegation (DWD). No googleapis / google-auth-library dep —
// the whole thing is a JWT signed with node:crypto plus fetch(), the same
// hand-rolled API-client convention as src/lib/unipile/client.ts.
//
// Why DWD instead of the usual OAuth consent flow: the sending inboxes are
// client-owned Google Workspace accounts on domains the operator controls.
// A domain admin authorizes this one service account's client ID for the
// gmail.send + gmail.readonly scopes in the Admin console (once per domain),
// and from then on the service account can impersonate ANY mailbox on that
// domain by setting `sub` to the mailbox address. No per-user consent
// screens, no Google verification/CASA, no token-refresh dance.
//
// Error taxonomy mirrors src/lib/notifications/resend-client.ts: callers
// distinguish retryable failures (rate limit / transient 5xx) from permanent
// ones. GmailAuthError specifically means "this mailbox's delegation is
// misconfigured or revoked" — the worker flips the mailbox to status='error'
// rather than retrying.
//
// No token-bucket throttle here (unlike the Resend client): the send worker
// awaits sends sequentially inside a 15-min cron, so there is no burst to
// smooth. Gmail's per-user quota (250 units/sec; a send costs 100) is far
// above one-at-a-time sending. Add a bucket only if we ever parallelize.

import { randomUUID } from "node:crypto";

import {
  GoogleServiceAccount,
  GoogleAuthError,
  GoogleConfigError,
  GooglePermanentError,
  GoogleRateLimitError,
  GoogleTransientError,
} from "@/lib/google/auth";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_SCOPES =
  "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

// ---------- Typed errors ----------
// These subclass the generic Google* forms (src/lib/google/auth.ts) so the
// shared token minter's errors translate cleanly (see asGmailError) while
// every existing `instanceof GmailAuthError` call site keeps matching.

export class GmailConfigError extends GoogleConfigError {
  constructor(message: string) {
    super(message);
    this.name = "GmailConfigError";
  }
}

// Delegation not authorized / revoked for this mailbox, or the SA key is
// bad. Permanent for this mailbox until an admin fixes the Google side.
export class GmailAuthError extends GoogleAuthError {
  constructor(message: string) {
    super(message);
    this.name = "GmailAuthError";
  }
}

export class GmailRateLimitError extends GoogleRateLimitError {
  constructor(message = "Gmail rate-limited") {
    super(message);
    this.name = "GmailRateLimitError";
  }
}

export class GmailTransientError extends GoogleTransientError {
  constructor(message: string) {
    super(message);
    this.name = "GmailTransientError";
  }
}

export class GmailPermanentError extends GooglePermanentError {
  constructor(message: string) {
    super(message);
    this.name = "GmailPermanentError";
  }
}

// ---------- Message shapes (only the fields we read) ----------

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPayloadPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string };
  parts?: GmailPayloadPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string; // ms epoch as a string
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPayloadPart;
}

export interface GmailListEntry {
  id: string;
  threadId: string;
}

export interface GmailSendResult {
  id: string;
  threadId: string;
  labelIds?: string[];
}

/**
 * Gmail client scoped to a single service account. Call impersonate(email)
 * to act as one mailbox; the same client instance can impersonate any
 * mailbox on an authorized domain. Token minting lives in the shared
 * GoogleServiceAccount (src/lib/google/auth.ts); this class composes it with
 * the Gmail scopes + base URL.
 */
export class GmailClient {
  private sa: GoogleServiceAccount;

  constructor(serviceAccountEmail: string, privateKeyPem: string) {
    const email = (serviceAccountEmail ?? "").trim();
    const key = (privateKeyPem ?? "").trim();
    if (!email || !key) {
      throw new GmailConfigError(
        "Gmail service account is not configured (email or private key missing).",
      );
    }
    this.sa = new GoogleServiceAccount(email, key);
  }

  private async getAccessToken(subject: string): Promise<string> {
    try {
      return await this.sa.getAccessToken(subject, GMAIL_SCOPES);
    } catch (err) {
      // The shared minter throws the generic Google* forms; translate to the
      // Gmail* subclasses so callers' instanceof checks match.
      throw asGmailError(err);
    }
  }

  private async gmailFetch(
    subject: string,
    path: string,
    init?: RequestInit,
  ): Promise<unknown> {
    const token = await this.getAccessToken(subject);
    const res = await fetch(`${GMAIL_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw classifyApiError(res.status, text);
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new GmailTransientError(
        `Gmail returned non-JSON: ${text.slice(0, 200)}`,
      );
    }
  }

  /**
   * Send a raw (base64url-encoded RFC 5322) message as `mailbox`. Pass
   * threadId to make Gmail attach it to an existing thread (follow-up steps).
   */
  async sendMessage(
    mailbox: string,
    rawBase64Url: string,
    threadId?: string,
  ): Promise<GmailSendResult> {
    const body: Record<string, string> = { raw: rawBase64Url };
    if (threadId) body.threadId = threadId;
    const data = (await this.gmailFetch(mailbox, "/messages/send", {
      method: "POST",
      body: JSON.stringify(body),
    })) as GmailSendResult;
    return data;
  }

  /**
   * List message ids in `mailbox` matching a Gmail search query (e.g.
   * "in:inbox after:<epoch>"). includeSpamTrash widens the search to SPAM and
   * TRASH (the placement checker needs it: a probe filtered to spam is exactly
   * the result we're looking for, and Gmail hides spam from searches by
   * default unless the query itself says in:spam).
   */
  async listMessages(
    mailbox: string,
    query: string,
    maxResults = 25,
    includeSpamTrash = false,
  ): Promise<GmailListEntry[]> {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });
    if (includeSpamTrash) params.set("includeSpamTrash", "true");
    const data = (await this.gmailFetch(
      mailbox,
      `/messages?${params.toString()}`,
    )) as { messages?: GmailListEntry[] };
    return data.messages ?? [];
  }

  /**
   * Fetch one message. format 'full' returns the parsed payload; 'metadata'
   * returns only the requested headers (used to read back the authoritative
   * Message-ID after a send).
   */
  async getMessage(
    mailbox: string,
    id: string,
    format: "full" | "metadata" = "full",
    metadataHeaders?: string[],
  ): Promise<GmailMessage> {
    const params = new URLSearchParams({ format });
    for (const h of metadataHeaders ?? []) params.append("metadataHeaders", h);
    const data = (await this.gmailFetch(
      mailbox,
      `/messages/${id}?${params.toString()}`,
    )) as GmailMessage;
    return data;
  }

  /**
   * Read the mailbox profile. Cheap call used to verify domain-wide
   * delegation is authorized for a mailbox before we let campaigns use it.
   */
  async getProfile(
    mailbox: string,
  ): Promise<{ emailAddress: string; messagesTotal?: number }> {
    const data = (await this.gmailFetch(mailbox, "/profile")) as {
      emailAddress: string;
      messagesTotal?: number;
    };
    return data;
  }
}

// Translate a generic Google* error from the shared token minter into the
// matching Gmail* subclass. A parent-class instance is not `instanceof` its
// child, so without this the Gmail* call sites would stop catching token
// failures. Already-Gmail errors pass through untouched.
function asGmailError(err: unknown): unknown {
  if (
    err instanceof GmailConfigError ||
    err instanceof GmailAuthError ||
    err instanceof GmailRateLimitError ||
    err instanceof GmailTransientError ||
    err instanceof GmailPermanentError
  ) {
    return err;
  }
  if (err instanceof GoogleConfigError) return new GmailConfigError(err.message);
  if (err instanceof GoogleRateLimitError) {
    return new GmailRateLimitError(err.message);
  }
  if (err instanceof GoogleTransientError) {
    return new GmailTransientError(err.message);
  }
  if (err instanceof GooglePermanentError) {
    return new GmailPermanentError(err.message);
  }
  if (err instanceof GoogleAuthError) return new GmailAuthError(err.message);
  return err;
}

function classifyApiError(status: number, bodyText: string): Error {
  let message = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
    message = parsed.error?.message ?? bodyText;
  } catch {
    /* keep raw body */
  }
  if (status === 401 || status === 403) {
    return new GmailAuthError(`Gmail ${status}: ${message}`);
  }
  if (status === 429) return new GmailRateLimitError(message);
  if (status >= 500) return new GmailTransientError(`Gmail ${status}: ${message}`);
  return new GmailPermanentError(`Gmail ${status}: ${message}`);
}

// Re-export for callers that build their own Message-ID before send.
export { randomUUID };
