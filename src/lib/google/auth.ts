// Shared Google service-account (domain-wide delegation) auth substrate.
//
// Extracted from src/lib/gmail/client.ts so the Gmail sender AND the domain /
// inbox provisioning clients (Admin SDK Directory, Site Verification,
// Licensing) can mint DWD access tokens from the same signed-JWT core. No
// googleapis / google-auth-library dep: the whole thing is a JWT signed with
// node:crypto plus fetch(), matching the hand-rolled convention already used
// for Gmail and Unipile.
//
// The service account impersonates a `subject` (a mailbox for Gmail, a
// super-admin for the Admin APIs) and requests a specific `scopes` string.
// Tokens are cached per (saEmail, subject, scopes). Scope MUST be part of the
// key: a token minted for gmail.send handed to an admin.directory call would
// 403, so the two must never collide in the cache.

import { createSign } from "node:crypto";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// Ceiling on one token-mint round trip; the callers run inside 60s functions.
const TOKEN_FETCH_TIMEOUT_MS = 10_000;

// ---------- Typed errors (generic Google forms) ----------
// Gmail's error classes (src/lib/gmail/client.ts) subclass these so existing
// `instanceof GmailAuthError` call sites keep matching. Network-derived
// errors carry the HTTP status so step runners can tell 409 (already exists,
// resume-ok) from a real failure.

export class GoogleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleConfigError";
  }
}

// Delegation not authorized / revoked, or the SA key is bad. Permanent for
// this subject until an admin fixes the Google side.
export class GoogleAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GoogleAuthError";
    this.status = status;
  }
}

export class GoogleRateLimitError extends Error {
  status?: number;
  constructor(message = "Google rate-limited", status?: number) {
    super(message);
    this.name = "GoogleRateLimitError";
    this.status = status;
  }
}

export class GoogleTransientError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GoogleTransientError";
    this.status = status;
  }
}

export class GooglePermanentError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GooglePermanentError";
    this.status = status;
  }
}

// ---------- base64url ----------

export function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---------- Access-token cache (per saEmail|subject|scopes) ----------

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
// Tokens live ~1h; we refresh 60s early.
const tokenCache = new Map<string, CachedToken>();

/**
 * The cache key. Scope-aware so the same impersonated subject holds
 * independent tokens per scope set (a Gmail token and an Admin-Directory
 * token for the same admin never overwrite each other).
 */
export function tokenCacheKey(
  saEmail: string,
  subject: string,
  scopes: string,
): string {
  return `${saEmail}|${subject}|${scopes}`;
}

/**
 * One Google service account. Mints DWD access tokens for any (subject,
 * scopes) pair via a node:crypto-signed JWT bearer grant. Compose it with a
 * base URL + scope set to build a concrete API client (see GmailClient and
 * the src/lib/google/* provisioning clients).
 */
export class GoogleServiceAccount {
  readonly email: string;
  private privateKeyPem: string;

  constructor(serviceAccountEmail: string, privateKeyPem: string) {
    const email = (serviceAccountEmail ?? "").trim();
    const key = (privateKeyPem ?? "").trim();
    if (!email || !key) {
      throw new GoogleConfigError(
        "Google service account is not configured (email or private key missing).",
      );
    }
    this.email = email;
    // Keys pasted from a service-account JSON arrive with literal "\n"
    // escapes instead of real newlines. Normalize so createSign gets a valid
    // PEM either way.
    this.privateKeyPem = key.replace(/\\n/g, "\n");
  }

  async getAccessToken(subject: string, scopes: string): Promise<string> {
    const cacheKey = tokenCacheKey(this.email, subject, scopes);
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
        iss: this.email,
        sub: subject, // the subject we impersonate
        scope: scopes,
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
      // A key that will not sign is an ORG-level configuration problem, not a
      // per-subject delegation failure: as an auth error it benched every
      // mailbox in the org in one tick (SEND_RUNTIME_AUDIT.md SEND-21). As a
      // config error the send worker skips the org for the tick instead.
      throw new GoogleConfigError(
        `Failed to sign JWT (bad service-account key?): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const assertion = `${signingInput}.${signature}`;

    // Network failures and stalls are transient (retry next tick), never a
    // reason to bench a mailbox or fail a lead (SEND-18 / SEND-34).
    let res: Response;
    let bodyText: string;
    try {
      res = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
        signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
      });
      bodyText = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new GoogleTransientError(`Token endpoint unreachable: ${msg}`);
    }
    if (!res.ok) {
      // Google returns { error, error_description }. unauthorized_client /
      // invalid_grant here almost always means the domain admin hasn't
      // authorized this SA's client ID for these scopes on the subject's
      // domain, a permanent per-subject condition.
      throw classifyTokenError(res.status, bodyText, subject, scopes);
    }

    let parsed: { access_token?: string; expires_in?: number };
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new GoogleTransientError(
        `Token endpoint returned non-JSON: ${bodyText.slice(0, 200)}`,
      );
    }
    if (!parsed.access_token) {
      throw new GoogleAuthError("Token endpoint returned no access_token.");
    }

    tokenCache.set(cacheKey, {
      token: parsed.access_token,
      expiresAtMs: now + (parsed.expires_in ?? 3600) * 1000,
    });
    return parsed.access_token;
  }
}

/**
 * Classify a failure from the token endpoint. 429 -> rate limit, 5xx ->
 * transient, everything else -> auth (the SA can't impersonate this subject;
 * most commonly missing domain-wide delegation for `scopes`).
 */
export function classifyTokenError(
  status: number,
  bodyText: string,
  subject: string,
  scopes: string,
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
  if (status === 429) return new GoogleRateLimitError(desc, status);
  if (status >= 500) {
    return new GoogleTransientError(`Token ${status}: ${desc}`, status);
  }
  return new GoogleAuthError(
    `Cannot impersonate ${subject} (${errCode || status}): ${desc}. ` +
      `Check that the service account's client ID is authorized for ${scopes} ` +
      `in Google Admin, Security, API Controls, Domain-wide Delegation for this domain.`,
    status,
  );
}

/**
 * Classify a failure from a Google REST API call. `apiLabel` names the API in
 * the message (e.g. "Directory", "Site Verification"). 401/403 -> auth,
 * 429 -> rate limit, 5xx -> transient, else permanent. The caller inspects
 * `.status` to treat 409 (already exists) as a resume, not a failure.
 */
export function classifyApiError(
  status: number,
  bodyText: string,
  apiLabel: string,
): Error {
  let message = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
    message = parsed.error?.message ?? bodyText;
  } catch {
    /* keep raw body */
  }
  if (status === 401 || status === 403) {
    return new GoogleAuthError(`${apiLabel} ${status}: ${message}`, status);
  }
  if (status === 429) return new GoogleRateLimitError(message, status);
  if (status >= 500) {
    return new GoogleTransientError(`${apiLabel} ${status}: ${message}`, status);
  }
  return new GooglePermanentError(`${apiLabel} ${status}: ${message}`, status);
}

/** True when `err` is a classified Google error carrying this HTTP status. */
export function isGoogleStatus(err: unknown, status: number): boolean {
  return (
    (err instanceof GoogleAuthError ||
      err instanceof GoogleRateLimitError ||
      err instanceof GoogleTransientError ||
      err instanceof GooglePermanentError) &&
    err.status === status
  );
}

/**
 * Call a Google REST API as `subject` with `scopes`, returning the HTTP status
 * and parsed JSON. Throws a classified Google* error on non-2xx (the caller
 * checks `.status` / isGoogleStatus for resume cases). The one fetch shape all
 * the admin-subject clients (Directory / Site Verification / Licensing) share.
 */
export async function googleApiFetch<T = unknown>(params: {
  sa: GoogleServiceAccount;
  subject: string;
  scopes: string;
  baseUrl: string;
  path: string;
  apiLabel: string;
  method?: string;
  body?: unknown;
}): Promise<{ status: number; json: T }> {
  const { sa, subject, scopes, baseUrl, path, apiLabel, method, body } = params;
  const token = await sa.getAccessToken(subject, scopes);
  const res = await fetch(`${baseUrl}${path}`, {
    method: method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body != null ? { "Content-Type": "application/json" } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw classifyApiError(res.status, text, apiLabel);
  }
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new GoogleTransientError(
        `${apiLabel} returned non-JSON: ${text.slice(0, 200)}`,
      );
    }
  }
  return { status: res.status, json: json as T };
}
