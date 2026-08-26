// Microsoft Graph client for external seed inboxes (migration 00085).
//
// Hand-rolled fetch, no SDK — the house convention (same as gmail/client.ts
// and unipile/client.ts). Serves the 'microsoft_graph' seed provider: reads a
// personal Outlook.com or Microsoft 365 mailbox to find a placement probe and
// report its folder + receiver-side auth. OAuth from day one — Microsoft is
// retiring basic auth for SMTP AUTH on 2026-04-30, and Graph never needed it.
//
// Flow: buildAuthorizeUrl → (consent) → exchangeCode → {access, refresh}. The
// refresh token ROTATES on every use (MSA), so callers must persist the new
// one before the next read. Delegated scopes only: Mail.Read + User.Read.

export const MS_AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
export const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const MS_SEED_SCOPES = "offline_access Mail.Read User.Read";

export class MsGraphAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MsGraphAuthError";
  }
}
export class MsGraphRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MsGraphRateLimitError";
  }
}
export class MsGraphTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MsGraphTransientError";
  }
}
export class MsGraphPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MsGraphPermanentError";
  }
}

export interface MsTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAtMs: number;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

// AADSTS codes / OAuth errors that mean "the grant is dead — reconnect", as
// opposed to a transient blip. AADSTS7000222 = expired client secret.
const DEAD_GRANT_MARKERS = [
  "invalid_grant",
  "interaction_required",
  "AADSTS70000", // invalid/expired refresh token family
  "AADSTS7000222", // expired client secret
  "AADSTS50173", // credentials changed → token revoked
  "AADSTS500133", // assertion expired
];

function isDeadGrant(body: string): boolean {
  return DEAD_GRANT_MARKERS.some((m) => body.includes(m));
}

export class MsGraphClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  /** The consent URL the owner is redirected to. `state` is our signed CSRF token. */
  buildAuthorizeUrl(params: { redirectUri: string; state: string }): string {
    const q = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: params.redirectUri,
      response_mode: "query",
      scope: MS_SEED_SCOPES,
      state: params.state,
      prompt: "select_account",
    });
    return `${MS_AUTH_BASE}/authorize?${q.toString()}`;
  }

  /** Exchange an authorization code for the first token set. */
  async exchangeCode(params: { code: string; redirectUri: string }): Promise<MsTokenSet> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      scope: MS_SEED_SCOPES,
    });
  }

  /** Redeem a refresh token. Returns a NEW refresh token (rotated) — persist it. */
  async refresh(refreshToken: string): Promise<MsTokenSet> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: MS_SEED_SCOPES,
    });
  }

  private async tokenRequest(fields: Record<string, string>): Promise<MsTokenSet> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...fields,
    });
    let res: Response;
    try {
      res = await fetch(`${MS_AUTH_BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (err) {
      throw new MsGraphTransientError(
        `Microsoft token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 429) throw new MsGraphRateLimitError("Microsoft token endpoint rate-limited.");
      if (res.status >= 500) throw new MsGraphTransientError(`Microsoft token endpoint ${res.status}.`);
      if (isDeadGrant(text)) {
        throw new MsGraphAuthError("Microsoft sign-in expired — reconnect this seed.");
      }
      throw new MsGraphPermanentError(`Microsoft token exchange failed (${res.status}): ${text.slice(0, 300)}`);
    }
    let json: RawTokenResponse;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MsGraphTransientError("Microsoft token endpoint returned non-JSON.");
    }
    if (!json.access_token || !json.refresh_token) {
      throw new MsGraphPermanentError("Microsoft token response was missing a token.");
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAtMs: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
  }

  // ── Graph reads (with an access token) ─────────────────────────────────

  private async graphGet<T>(accessToken: string, path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${MS_GRAPH_BASE}${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      throw new MsGraphTransientError(
        `Graph request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new MsGraphAuthError("Microsoft access was rejected — reconnect this seed.");
    }
    if (res.status === 429) throw new MsGraphRateLimitError("Graph rate-limited.");
    if (res.status >= 500) throw new MsGraphTransientError(`Graph ${res.status}.`);
    const text = await res.text();
    if (!res.ok) {
      throw new MsGraphPermanentError(`Graph ${res.status}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MsGraphTransientError("Graph returned non-JSON.");
    }
  }

  /** The signed-in seed's own address (mail, falling back to userPrincipalName). */
  async me(accessToken: string): Promise<{ email: string }> {
    const data = await this.graphGet<{ mail?: string; userPrincipalName?: string }>(
      accessToken,
      "/me?$select=mail,userPrincipalName",
    );
    const email = (data.mail || data.userPrincipalName || "").trim().toLowerCase();
    if (!email) throw new MsGraphPermanentError("Graph /me returned no address.");
    return { email };
  }

  /** Resolve a well-known folder to its id (locale-proof). */
  async wellKnownFolderId(accessToken: string, name: "inbox" | "junkemail"): Promise<string> {
    const data = await this.graphGet<{ id: string }>(
      accessToken,
      `/me/mailFolders/${name}?$select=id`,
    );
    return data.id;
  }

  /**
   * Find a message anywhere in the mailbox by its RFC Message-ID. Graph stores
   * the id WITH angle brackets; single-quotes in an OData string literal are
   * escaped by doubling. /me/messages spans every folder (Inbox, Junk, Deleted).
   */
  async findMessageByInternetMessageId(
    accessToken: string,
    idWithBrackets: string,
  ): Promise<{ id: string; parentFolderId: string } | null> {
    const literal = idWithBrackets.replace(/'/g, "''");
    const filter = encodeURIComponent(`internetMessageId eq '${literal}'`);
    const data = await this.graphGet<{ value: { id: string; parentFolderId: string }[] }>(
      accessToken,
      `/me/messages?$filter=${filter}&$select=id,parentFolderId&$top=2`,
    );
    return data.value?.[0] ?? null;
  }

  /** Message metadata: folder, Focused/Other class, and the internet headers. */
  async getMessageMeta(
    accessToken: string,
    id: string,
  ): Promise<{
    parentFolderId: string;
    inferenceClassification: string | null;
    internetMessageHeaders: { name: string; value: string }[];
  }> {
    const data = await this.graphGet<{
      parentFolderId: string;
      inferenceClassification?: string;
      internetMessageHeaders?: { name: string; value: string }[];
    }>(
      accessToken,
      `/me/messages/${id}?$select=parentFolderId,inferenceClassification,internetMessageHeaders`,
    );
    return {
      parentFolderId: data.parentFolderId,
      inferenceClassification: data.inferenceClassification ?? null,
      internetMessageHeaders: data.internetMessageHeaders ?? [],
    };
  }

  /** Display name of an arbitrary folder — only fetched for the 'other' branch. */
  async folderDisplayName(accessToken: string, folderId: string): Promise<string> {
    try {
      const data = await this.graphGet<{ displayName?: string }>(
        accessToken,
        `/me/mailFolders/${folderId}?$select=displayName`,
      );
      return data.displayName ?? folderId;
    } catch {
      return folderId;
    }
  }
}
