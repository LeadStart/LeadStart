// Hand-rolled Gmail API client using a Google service account with
// domain-wide delegation (DWD). No googleapis / google-auth-library dep —
// the whole thing is a JWT signed with node:crypto plus fetch(), the same
// hand-rolled-client convention as src/lib/salesforge/client.ts and
// src/lib/unipile/client.ts.
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

import { createSign, randomUUID } from "node:crypto";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_SCOPES =
  "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

// ---------- Typed errors ----------

export class GmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailConfigError";
  }
}

// Delegation not authorized / revoked for this mailbox, or the SA key is
// bad. Permanent for this mailbox until an admin fixes the Google side.
export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailAuthError";
  }
}

export class GmailRateLimitError extends Error {
  constructor(message = "Gmail rate-limited") {
    super(message);
    this.name = "GmailRateLimitError";
  }
}

export class GmailTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailTransientError";
  }
}

export class GmailPermanentError extends Error {
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

// ---------- base64url ----------

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---------- Access-token cache (per impersonated mailbox) ----------

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
// Keyed by `${saEmail}|${subject}`. Tokens live ~1h; we refresh 60s early.
const tokenCache = new Map<string, CachedToken>();

/**
 * Gmail client scoped to a single service account. Call impersonate(email)
 * to act as one mailbox; the same client instance can impersonate any
 * mailbox on an authorized domain.
 */
export class GmailClient {
  private saEmail: string;
  private privateKeyPem: string;

  constructor(serviceAccountEmail: string, privateKeyPem: string) {
    const email = (serviceAccountEmail ?? "").trim();
    const key = (privateKeyPem ?? "").trim();
    if (!email || !key) {
      throw new GmailConfigError(
        "Gmail service account is not configured (email or private key missing).",
      );
    }
    this.saEmail = email;
    // Keys pasted from a Google service-account JSON arrive with literal
    // "\n" escapes instead of real newlines — normalize so createSign gets
    // a valid PEM either way.
    this.privateKeyPem = key.replace(/\\n/g, "\n");
  }

  private async getAccessToken(subject: string): Promise<string> {
    const cacheKey = `${this.saEmail}|${subject}`;
    const cached = tokenCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAtMs - 60_000 > now) {
      return cached.token;
    }

    const iat = Math.floor(now / 1000);
    const exp = iat + 3600;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iss: this.saEmail,
        sub: subject, // the mailbox we impersonate
        scope: GMAIL_SCOPES,
        aud: TOKEN_ENDPOINT,
        iat,
        exp,
      }),
    );
    const signingInput = `${header}.${claims}`;

    let signature: string;
    try {
      const signer = createSign("RSA-SHA256");
      signer.update(signingInput);
      signer.end();
      signature = base64url(signer.sign(this.privateKeyPem));
    } catch (err) {
      throw new GmailAuthError(
        `Failed to sign JWT (bad service-account key?): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const assertion = `${signingInput}.${signature}`;

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      // Google returns { error, error_description }. unauthorized_client /
      // invalid_grant here almost always means the domain admin hasn't
      // authorized this SA's client ID for these scopes on `subject`'s
      // domain — a permanent per-mailbox condition.
      throw classifyTokenError(res.status, bodyText, subject);
    }

    let parsed: { access_token?: string; expires_in?: number };
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new GmailTransientError(
        `Token endpoint returned non-JSON: ${bodyText.slice(0, 200)}`,
      );
    }
    if (!parsed.access_token) {
      throw new GmailAuthError("Token endpoint returned no access_token.");
    }

    tokenCache.set(cacheKey, {
      token: parsed.access_token,
      expiresAtMs: now + (parsed.expires_in ?? 3600) * 1000,
    });
    return parsed.access_token;
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

  /** List message ids in `mailbox` matching a Gmail search query (e.g. "in:inbox after:<epoch>"). */
  async listMessages(
    mailbox: string,
    query: string,
    maxResults = 25,
  ): Promise<GmailListEntry[]> {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });
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

function classifyTokenError(
  status: number,
  bodyText: string,
  subject: string,
): Error {
  let errCode = "";
  let desc = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: string;
      error_description?: string;
    };
    errCode = parsed.error ?? "";
    desc = parsed.error_description ?? bodyText;
  } catch {
    /* keep raw body */
  }
  if (status === 429) return new GmailRateLimitError(desc);
  if (status >= 500) return new GmailTransientError(`Token ${status}: ${desc}`);
  // 400/401/403 at the token endpoint = the SA can't impersonate this
  // mailbox. Most common cause is missing domain-wide delegation.
  return new GmailAuthError(
    `Cannot impersonate ${subject} (${errCode || status}): ${desc}. ` +
      `Check that the service account's client ID is authorized for ${GMAIL_SCOPES} ` +
      `in Google Admin → Security → API Controls → Domain-wide Delegation for this domain.`,
  );
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
