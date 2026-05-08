import type {
  SalesforgeMe,
  SalesforgeWorkspace,
  SalesforgeWorkspaceList,
  SalesforgeProduct,
  SalesforgeProductList,
  SalesforgeSequence,
  SalesforgeSequenceList,
  SalesforgeAnalytics,
  SalesforgeMailbox,
  SalesforgeMailboxList,
  SalesforgeEmail,
  SalesforgeContactCreate,
  SalesforgeContactBulkResponse,
  SalesforgeReplyRequest,
  SalesforgeWebhook,
  SalesforgeWebhookList,
  SalesforgeWebhookCreate,
} from "./types";

// Salesforge public API host. The path prefix /public/v2 is part of the
// base URL — the swagger spec lives at /public/v2/swagger/index.html.
// The multichannel surface lives at https://multichannel-api.salesforge.ai
// and is a different product — we are NOT calling it from this client.
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
    // Confirmed against https://api.salesforge.ai/public/v2/me on
    // 2026-05-07: raw key returns 200 with {accountId, apiKeyName}; Bearer
    // returns 401 {"message":"invalid api key"}.
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

        // 204 No Content is returned by DELETE endpoints — there is no
        // JSON body to parse.
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
  //   { total: number, offset: number, limit: number, data: T[] }
  // A bare array or { items: T[] } variant is also tolerated for any
  // endpoint that diverges from this shape.
  private unwrapList<T>(
    response: { data?: T[]; items?: T[] } | T[],
  ): T[] {
    if (Array.isArray(response)) return response;
    return response.data ?? response.items ?? [];
  }

  // ===== ME =====

  // GET /me — used by the connection-test button on /admin/settings/api.
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

  // ===== SEQUENCES (legacy = "campaigns") =====

  async listSequences(workspaceId: string): Promise<SalesforgeSequence[]> {
    const response = await this.request<SalesforgeSequenceList | SalesforgeSequence[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sequences`
    );
    return this.unwrapList(response);
  }

  async getSequence(sequenceId: string): Promise<SalesforgeSequence> {
    return this.request<SalesforgeSequence>(
      `/sequences/${encodeURIComponent(sequenceId)}`
    );
  }

  async pauseSequence(sequenceId: string): Promise<SalesforgeSequence> {
    return this.request<SalesforgeSequence>(
      `/sequences/${encodeURIComponent(sequenceId)}/pause`,
      { method: "POST" }
    );
  }

  async resumeSequence(sequenceId: string): Promise<SalesforgeSequence> {
    return this.request<SalesforgeSequence>(
      `/sequences/${encodeURIComponent(sequenceId)}/resume`,
      { method: "POST" }
    );
  }

  // DELETE /sequences/{id} is permanent on Salesforge's side — caller
  // must run the user-facing confirm flow before calling.
  async deleteSequence(sequenceId: string): Promise<void> {
    await this.request<unknown>(
      `/sequences/${encodeURIComponent(sequenceId)}`,
      { method: "DELETE" }
    );
  }

  // ===== ANALYTICS =====

  // GET /sequences/{id}/analytics?from_date=&to_date=
  // Used by the sync-analytics cron to fill campaign_snapshots.
  async getSequenceAnalytics(
    sequenceId: string,
    fromDate?: string,
    toDate?: string
  ): Promise<SalesforgeAnalytics> {
    const params = new URLSearchParams();
    if (fromDate) params.set("from_date", fromDate);
    if (toDate) params.set("to_date", toDate);
    const qs = params.toString();
    return this.request<SalesforgeAnalytics>(
      `/sequences/${encodeURIComponent(sequenceId)}/analytics${qs ? `?${qs}` : ""}`
    );
  }

  // ===== MAILBOXES =====

  // GET /workspaces/{ws}/mailboxes — used by the Inbox Health page to
  // list connected sending mailboxes. Warmforge powers the per-mailbox
  // heat score; this list provides only status + daily limit.
  async listMailboxes(workspaceId: string): Promise<SalesforgeMailbox[]> {
    const response = await this.request<SalesforgeMailboxList | SalesforgeMailbox[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/mailboxes`
    );
    return this.unwrapList(response);
  }

  // ===== CONTACTS =====

  // POST /contacts/bulk — Salesforge caps a single request at 100
  // contacts. The bulk-add wrapper below batches automatically, so
  // callers can pass arbitrarily large lists.
  async addContactsBulk(
    contacts: SalesforgeContactCreate[]
  ): Promise<SalesforgeContactBulkResponse> {
    return this.request<SalesforgeContactBulkResponse>("/contacts/bulk", {
      method: "POST",
      body: JSON.stringify({ contacts }),
    });
  }

  // PUT /sequences/{id}/contacts — associate already-created contacts
  // with the given sequence. Salesforge expects an array of contact ids
  // (the ids returned by /contacts/bulk).
  async addContactsToSequence(
    sequenceId: string,
    contactIds: string[]
  ): Promise<unknown> {
    return this.request<unknown>(
      `/sequences/${encodeURIComponent(sequenceId)}/contacts`,
      {
        method: "PUT",
        body: JSON.stringify({ contact_ids: contactIds }),
      }
    );
  }

  // Convenience wrapper used by the push-to-campaign admin action.
  // Splits the list into 100-contact chunks (Salesforge's documented
  // bulk limit), calls /contacts/bulk for each, then enrolls every
  // returned contact id into the sequence in a single PUT.
  async pushContactsToSequence(
    sequenceId: string,
    contacts: SalesforgeContactCreate[]
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
        const response = await this.addContactsBulk(chunk);
        if (response.contacts) {
          for (const c of response.contacts) {
            createdIds.push(c.id);
          }
        }
        if (response.failed) {
          for (const f of response.failed) {
            failed.push({ email: f.email ?? null, error: f.error });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const c of chunk) {
          failed.push({ email: c.email, error: message });
        }
      }
    }

    if (createdIds.length > 0) {
      try {
        await this.addContactsToSequence(sequenceId, createdIds);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // If sequence enrollment fails after contacts were created,
        // the contacts exist in Salesforge but are not in the sequence.
        // Surface as a single aggregate failure so the caller knows the
        // sequence assignment did not happen.
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

  // GET /workspaces/{ws}/mailboxes/{mb}/emails/{em} — used by the
  // ingest pipeline to enrich a sparse webhook payload with the full
  // email body when needed.
  async getEmail(
    workspaceId: string,
    mailboxId: string,
    emailId: string
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
    request: SalesforgeReplyRequest
  ): Promise<SalesforgeEmail> {
    return this.request<SalesforgeEmail>(
      `/workspaces/${encodeURIComponent(workspaceId)}/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify(request),
      }
    );
  }

  // ===== WEBHOOKS =====

  // GET /webhooks — listing is mandatory before every register call,
  // since Salesforge has no DELETE endpoint and duplicate registrations
  // would just stack indefinitely.
  async listWebhooks(): Promise<SalesforgeWebhook[]> {
    const response = await this.request<SalesforgeWebhookList | SalesforgeWebhook[]>(
      "/webhooks"
    );
    return this.unwrapList(response);
  }

  // POST /webhooks — register a single (sequence, event_type, url)
  // subscription. Use registerSequenceWebhooks (in webhooks.ts) for
  // the idempotent "register all events for a sequence" flow.
  async createWebhook(
    request: SalesforgeWebhookCreate
  ): Promise<SalesforgeWebhook> {
    return this.request<SalesforgeWebhook>("/webhooks", {
      method: "POST",
      body: JSON.stringify(request),
    });
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
