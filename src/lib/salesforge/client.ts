import type {
  SalesforgeMe,
  SalesforgeWorkspace,
  SalesforgeWorkspaceList,
  SalesforgeProduct,
  SalesforgeProductList,
  SalesforgeSequence,
  SalesforgeSequenceList,
  SalesforgeSequenceStatus,
  SalesforgeAnalytics,
  SalesforgeMailbox,
  SalesforgeMailboxList,
  SalesforgeEmail,
  SalesforgeContactCreate,
  SalesforgeContactBulkResponse,
  SalesforgeReplyRequest,
  SalesforgeWebhook,
  SalesforgeWebhookList,
  SalesforgeCreateWebhookRequest,
  SalesforgeCreateSequenceRequest,
  SalesforgeStepRequest,
} from "./types";

// Salesforge public API host. The path prefix /public/v2 IS part of the
// base URL — confirmed via the spec at /public/v2/swagger/index.html.
// Hitting api.salesforge.ai/<endpoint> directly returns 401 with no
// hint, which previously misled the integration. The multichannel
// surface lives at https://multichannel-api.salesforge.ai and is a
// different product — we are NOT calling it from this client.
const BASE_URL = "https://api.salesforge.ai/public/v2";

export class SalesforgeClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${BASE_URL}${endpoint}`;
    let lastError: Error | null = null;

    // Salesforge's auth header is the RAW key, NOT prefixed with "Bearer".
    // Confirmed against /public/v2/me on 2026-05-07: raw returns 200 with
    // {accountId, apiKeyName}; Bearer returns 401 {"message":"invalid api key"}.
    const baseHeaders: Record<string, string> = {
      Authorization: this.apiKey,
    };
    if (options.body !== undefined && options.body !== null) {
      baseHeaders["Content-Type"] = "application/json";
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            ...baseHeaders,
            ...options.headers,
          },
        });

        if (response.status === 429) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(
            `Salesforge API error ${response.status}: ${errorBody}`
          );
        }

        // 204 No Content is returned by some PUT/DELETE endpoints — there
        // is no JSON body to parse.
        if (response.status === 204) {
          return undefined as T;
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error as Error;
        if (attempt < 2) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error("Salesforge API request failed");
  }

  // Salesforge list endpoints wrap results in a paginated envelope:
  //   { total, offset, limit, data: T[] }
  // A bare array or { items: T[] } variant is also tolerated for any
  // endpoint that diverges from this shape.
  private unwrapList<T>(
    response: { data?: T[]; items?: T[] } | T[],
  ): T[] {
    if (Array.isArray(response)) return response;
    return response.data ?? response.items ?? [];
  }

  // ===== ME =====

  async getMe(): Promise<SalesforgeMe> {
    return this.request<SalesforgeMe>("/me");
  }

  // ===== WORKSPACES + PRODUCTS =====

  async listWorkspaces(): Promise<SalesforgeWorkspace[]> {
    const response = await this.request<SalesforgeWorkspaceList | SalesforgeWorkspace[]>(
      "/workspaces"
    );
    return this.unwrapList(response);
  }

  async listProducts(workspaceId: string): Promise<SalesforgeProduct[]> {
    const response = await this.request<SalesforgeProductList | SalesforgeProduct[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/products`
    );
    return this.unwrapList(response);
  }

  // ===== SEQUENCES =====

  async listSequences(workspaceId: string): Promise<SalesforgeSequence[]> {
    const response = await this.request<SalesforgeSequenceList | SalesforgeSequence[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sequences`
    );
    return this.unwrapList(response);
  }

  async getSequence(workspaceId: string, sequenceId: string): Promise<SalesforgeSequence> {
    return this.request<SalesforgeSequence>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sequences/${encodeURIComponent(sequenceId)}`
    );
  }

  // POST /workspaces/{ws}/sequences — create a new sequence shell.
  // After creation the caller typically follows up with
  // updateSequenceSteps + assignSequenceMailboxes + updateSequenceStatus.
  async createSequence(
    workspaceId: string,
    request: SalesforgeCreateSequenceRequest,
  ): Promise<SalesforgeSequence> {
    return this.request<SalesforgeSequence>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sequences`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  // PUT /workspaces/{ws}/sequences/{seq}/steps — replaces the sequence's
  // step list. Salesforge accepts an empty `id` for new steps and
  // generates one server-side.
  async updateSequenceSteps(
    workspaceId: string,
    sequenceId: string,
    steps: SalesforgeStepRequest[],
  ): Promise<unknown> {
    return this.request<unknown>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sequences/${encodeURIComponent(sequenceId)}/steps`,
      {
        method: "PUT",
        body: JSON.stringify({ steps }),
      },
    );
  }

  // PUT /workspaces/{ws}/sequences/{seq}/mailboxes — sets the list of
  // sending mailboxes for the sequence. Replaces the previous list.
  async assignSequenceMailboxes(
    workspaceId: string,
    sequenceId: string,
    mailboxIds: string[],
  ): Promise<unknown> {
    return this.request<unknown>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sequences/${encodeURIComponent(sequenceId)}/mailboxes`,
      {
        method: "PUT",
        body: JSON.stringify({ mailboxIds }),
      },
    );
  }

  // PUT /workspaces/{ws}/sequences/{seq}/status — replaces the legacy
  // /pause and /resume endpoints (those don't exist on /public/v2).
  async updateSequenceStatus(
    workspaceId: string,
    sequenceId: string,
    status: SalesforgeSequenceStatus,
  ): Promise<unknown> {
    return this.request<unknown>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sequences/${encodeURIComponent(sequenceId)}/status`,
      {
        method: "PUT",
        body: JSON.stringify({ status }),
      },
    );
  }

  // Convenience wrappers around updateSequenceStatus.
  async pauseSequence(workspaceId: string, sequenceId: string): Promise<unknown> {
    return this.updateSequenceStatus(workspaceId, sequenceId, "paused");
  }

  async resumeSequence(workspaceId: string, sequenceId: string): Promise<unknown> {
    return this.updateSequenceStatus(workspaceId, sequenceId, "active");
  }

  // DELETE /workspaces/{ws}/sequences/{seq} — permanent on Salesforge's
  // side. Caller is responsible for the user-facing confirm flow.
  async deleteSequence(workspaceId: string, sequenceId: string): Promise<void> {
    await this.request<unknown>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sequences/${encodeURIComponent(sequenceId)}`,
      { method: "DELETE" },
    );
  }

  // ===== ANALYTICS =====

  // GET /workspaces/{ws}/sequences/{seq}/analytics?from_date=&to_date=
  // Returns { days: { 'YYYY-MM-DD': {sent, replied, ...} }, stats: {...} }
  // — note `days` is an object map keyed by date string, NOT an array.
  async getSequenceAnalytics(
    workspaceId: string,
    sequenceId: string,
    fromDate?: string,
    toDate?: string,
  ): Promise<SalesforgeAnalytics> {
    const params = new URLSearchParams();
    if (fromDate) params.set("from_date", fromDate);
    if (toDate) params.set("to_date", toDate);
    const qs = params.toString();
    return this.request<SalesforgeAnalytics>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sequences/${encodeURIComponent(sequenceId)}/analytics${qs ? `?${qs}` : ""}`
    );
  }

  // ===== MAILBOXES =====

  async listMailboxes(workspaceId: string): Promise<SalesforgeMailbox[]> {
    const response = await this.request<SalesforgeMailboxList | SalesforgeMailbox[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/mailboxes`
    );
    return this.unwrapList(response);
  }

  // ===== CONTACTS =====

  // POST /workspaces/{ws}/contacts/bulk — Salesforge caps a single
  // request at 100 contacts. The pushContactsToSequence wrapper below
  // batches automatically, so callers can pass arbitrarily large lists.
  async addContactsBulk(
    workspaceId: string,
    contacts: SalesforgeContactCreate[],
  ): Promise<SalesforgeContactBulkResponse> {
    return this.request<SalesforgeContactBulkResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/contacts/bulk`,
      {
        method: "POST",
        body: JSON.stringify({ contacts }),
      },
    );
  }

  // PUT /workspaces/{ws}/sequences/{seq}/contacts — associate already-
  // created contacts with the given sequence. Body is { contactIds: [...] }
  // (camelCase, NOT contact_ids).
  async addContactsToSequence(
    workspaceId: string,
    sequenceId: string,
    contactIds: string[],
  ): Promise<unknown> {
    return this.request<unknown>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sequences/${encodeURIComponent(sequenceId)}/contacts`,
      {
        method: "PUT",
        body: JSON.stringify({ contactIds }),
      },
    );
  }

  // Convenience wrapper used by the push-to-campaign admin action.
  // Splits the list into 100-contact chunks (Salesforge's bulk limit),
  // calls /contacts/bulk for each, then enrolls every returned contact
  // id into the sequence in a single PUT.
  async pushContactsToSequence(
    workspaceId: string,
    sequenceId: string,
    contacts: SalesforgeContactCreate[],
  ): Promise<{
    uploaded: number;
    failed: { email: string | null; error: string }[];
  }> {
    const failed: { email: string | null; error: string }[] = [];
    const createdIds: string[] = [];

    const chunkSize = 100;
    for (let i = 0; i < contacts.length; i += chunkSize) {
      const chunk = contacts.slice(i, i + chunkSize);
      try {
        const response = await this.addContactsBulk(workspaceId, chunk);
        if (response.contacts) {
          for (const c of response.contacts) {
            if (c.id) createdIds.push(c.id);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const c of chunk) {
          failed.push({ email: c.email ?? null, error: message });
        }
      }
    }

    if (createdIds.length > 0) {
      try {
        await this.addContactsToSequence(workspaceId, sequenceId, createdIds);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // If sequence enrollment fails after contacts were created,
        // the contacts exist in Salesforge but are not in the sequence.
        // Surface as a single aggregate failure.
        failed.push({
          email: null,
          error: `Sequence enrollment failed: ${message}`,
        });
        return { uploaded: 0, failed };
      }
    }

    return { uploaded: createdIds.length, failed };
  }

  // ===== EMAILS =====

  async getEmail(
    workspaceId: string,
    mailboxId: string,
    emailId: string,
  ): Promise<SalesforgeEmail> {
    return this.request<SalesforgeEmail>(
      `/workspaces/${encodeURIComponent(workspaceId)}/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}`
    );
  }

  // POST /workspaces/{ws}/mailboxes/{mb}/emails/{em}/reply — sends an
  // outbound reply through Salesforge. Subject is implicit (inferred
  // from the original thread server-side), so the request body is
  // body-only.
  async replyToEmail(
    workspaceId: string,
    mailboxId: string,
    emailId: string,
    request: SalesforgeReplyRequest,
  ): Promise<SalesforgeEmail> {
    return this.request<SalesforgeEmail>(
      `/workspaces/${encodeURIComponent(workspaceId)}/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  // ===== WEBHOOKS =====

  // GET /workspaces/{ws}/integrations/webhooks — paginated. List-then-
  // dedup is mandatory before every register call, since Salesforge has
  // no DELETE endpoint and duplicate registrations would just stack
  // indefinitely.
  async listWebhooks(workspaceId: string): Promise<SalesforgeWebhook[]> {
    const response = await this.request<SalesforgeWebhookList | SalesforgeWebhook[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/integrations/webhooks`
    );
    return this.unwrapList(response);
  }

  // POST /workspaces/{ws}/integrations/webhooks — register a single
  // (sequence, type, url) subscription. Use registerSequenceWebhooks
  // (in webhooks.ts) for the idempotent "register all events for a
  // sequence" flow.
  async createWebhook(
    workspaceId: string,
    request: SalesforgeCreateWebhookRequest,
  ): Promise<SalesforgeWebhook> {
    return this.request<SalesforgeWebhook>(
      `/workspaces/${encodeURIComponent(workspaceId)}/integrations/webhooks`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  // ===== CONNECTION TEST =====

  async testConnection(): Promise<boolean> {
    try {
      await this.getMe();
      return true;
    } catch {
      return false;
    }
  }
}
