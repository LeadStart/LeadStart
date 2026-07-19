import type {
  InstantlyCampaign,
  InstantlyCampaignListResponse,
  InstantlyAnalytics,
  InstantlyAnalyticsResponse,
  InstantlyLead,
  InstantlyLeadCreate,
  InstantlyLeadListResponse,
  InstantlyAccount,
  InstantlyAccountListResponse,
  InstantlyAccountDailyResponse,
  InstantlyWarmupAnalytics,
  InstantlyAccountCampaignMapping,
  InstantlyAccountCampaignMappingResponse,
  InstantlyStepAnalytics,
  InstantlyEmail,
  InstantlyEmailListResponse,
  InstantlyReplyRequest,
  InstantlyWebhookCreate,
  InstantlyWebhookResponse,
} from "./types";

const BASE_URL = "https://api.instantly.ai/api/v2";

export class InstantlyClient {
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

    // Instantly's Fastify backend rejects requests with Content-Type:
    // application/json and an empty body (FST_ERR_CTP_EMPTY_JSON_BODY) —
    // so we only declare the JSON content type when we're actually sending
    // a body. DELETEs and parameterless POSTs (pause/activate) ride bare.
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
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
          // Rate limited — exponential backoff
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(
            `Instantly API error ${response.status}: ${errorBody}`
          );
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

    throw lastError || new Error("Instantly API request failed");
  }

  // ===== CAMPAIGNS =====

  async listCampaigns(
    startingAfter?: string
  ): Promise<InstantlyCampaignListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (startingAfter) params.set("starting_after", startingAfter);
    return this.request<InstantlyCampaignListResponse>(
      `/campaigns?${params.toString()}`
    );
  }

  async getAllCampaigns(): Promise<InstantlyCampaign[]> {
    const all: InstantlyCampaign[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.listCampaigns(cursor);
      all.push(...response.items);
      cursor = response.next_starting_after;
    } while (cursor);

    return all;
  }

  // POST /api/v2/campaigns/{id}/pause — requires campaigns:update scope.
  async pauseCampaign(campaignId: string): Promise<InstantlyCampaign> {
    return this.request<InstantlyCampaign>(
      `/campaigns/${encodeURIComponent(campaignId)}/pause`,
      { method: "POST" },
    );
  }

  // POST /api/v2/campaigns/{id}/activate — covers both start and resume
  // per Instantly's docs.
  async activateCampaign(campaignId: string): Promise<InstantlyCampaign> {
    return this.request<InstantlyCampaign>(
      `/campaigns/${encodeURIComponent(campaignId)}/activate`,
      { method: "POST" },
    );
  }

  // DELETE /api/v2/campaigns/{id} — requires campaigns:delete scope. This
  // is permanent on Instantly's side. Caller is responsible for the UX
  // confirm flow.
  async deleteCampaign(campaignId: string): Promise<void> {
    await this.request<unknown>(
      `/campaigns/${encodeURIComponent(campaignId)}`,
      { method: "DELETE" },
    );
  }

  // ===== ANALYTICS =====

  async getCampaignAnalytics(
    campaignId?: string,
    startDate?: string,
    endDate?: string
  ): Promise<InstantlyAnalytics[]> {
    const params = new URLSearchParams();
    if (campaignId) params.set("campaign_id", campaignId);
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);

    const response = await this.request<InstantlyAnalytics[]>(
      `/campaigns/analytics?${params.toString()}`
    );
    return response;
  }

  async getDailyAnalytics(
    campaignId?: string,
    startDate?: string,
    endDate?: string
  ): Promise<InstantlyAnalyticsResponse> {
    const params = new URLSearchParams();
    if (campaignId) params.set("campaign_id", campaignId);
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);

    return this.request<InstantlyAnalyticsResponse>(
      `/campaigns/analytics/daily?${params.toString()}`
    );
  }

  // ===== STEP-LEVEL ANALYTICS =====

  async getStepAnalytics(
    campaignId?: string,
    startDate?: string,
    endDate?: string
  ): Promise<InstantlyStepAnalytics[]> {
    const params = new URLSearchParams();
    if (campaignId) params.set("campaign_id", campaignId);
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);

    return this.request<InstantlyStepAnalytics[]>(
      `/campaigns/analytics/steps?${params.toString()}`
    );
  }

  // ===== LEADS =====

  async listLeads(
    campaignId: string,
    startingAfter?: string
  ): Promise<InstantlyLeadListResponse> {
    const body: Record<string, unknown> = {
      campaign_id: campaignId,
      limit: 100,
    };
    if (startingAfter) body.starting_after = startingAfter;

    return this.request<InstantlyLeadListResponse>(`/leads/list`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // POST /api/v2/leads — create a single lead and assign it to a campaign.
  // The `campaign` field is the Instantly campaign UUID. Only `email` is
  // required by Instantly; everything else is optional. Custom variables go
  // in `personalization` / top-level fields per Instantly's lead schema.
  async addLead(input: InstantlyLeadCreate): Promise<InstantlyLead> {
    return this.request<InstantlyLead>("/leads", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  // Sequential bulk-add wrapper. Instantly v2's documented bulk-add endpoint
  // path varies across docs mirrors and isn't reliable to target — but the
  // single-lead /leads endpoint is stable and idempotent on its workspace
  // dedup (returns the existing lead when the email is already in the
  // campaign). Calling it sequentially keeps us under the ~10 req/sec rate
  // limit and surfaces per-lead failures cleanly.
  async addLeadsToCampaign(
    campaignId: string,
    leads: Omit<InstantlyLeadCreate, "campaign">[],
  ): Promise<{ uploaded: number; failed: { email: string | null; error: string }[] }> {
    let uploaded = 0;
    const failed: { email: string | null; error: string }[] = [];

    for (const lead of leads) {
      try {
        await this.addLead({ ...lead, campaign: campaignId });
        uploaded++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ email: lead.email ?? null, error: message });
      }
    }

    return { uploaded, failed };
  }

  // ===== ACCOUNTS / INBOXES =====

  async listAccounts(startingAfter?: string): Promise<InstantlyAccountListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (startingAfter) params.set("starting_after", startingAfter);
    return this.request<InstantlyAccountListResponse>(`/accounts?${params.toString()}`);
  }

  async getAllAccounts(): Promise<InstantlyAccount[]> {
    const all: InstantlyAccount[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.listAccounts(cursor);
      all.push(...response.items);
      cursor = response.next_starting_after;
    } while (cursor);
    return all;
  }

  async getAccountDailyAnalytics(
    emails?: string[],
    startDate?: string,
    endDate?: string
  ): Promise<InstantlyAccountDailyResponse> {
    const params = new URLSearchParams();
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    if (emails?.length) params.set("emails", emails.join(","));
    return this.request<InstantlyAccountDailyResponse>(`/accounts/analytics/daily?${params.toString()}`);
  }

  async getWarmupAnalytics(emails: string[]): Promise<InstantlyWarmupAnalytics[]> {
    return this.request<InstantlyWarmupAnalytics[]>(`/accounts/warmup-analytics`, {
      method: "POST",
      body: JSON.stringify({ emails }),
    });
  }

  // GET /api/v2/account-campaign-mappings/{email}
  // Per Instantly docs (https://developer.instantly.ai/api/v2/accountcampaignmapping/getaccountcampaignmapping)
  // there is no list-all endpoint — mappings are fetched per email.
  async getAccountCampaignMappings(
    email: string,
    startingAfter?: string,
  ): Promise<InstantlyAccountCampaignMappingResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (startingAfter) params.set("starting_after", startingAfter);
    return this.request<InstantlyAccountCampaignMappingResponse>(
      `/account-campaign-mappings/${encodeURIComponent(email)}?${params.toString()}`,
    );
  }

  // DELETE /api/v2/accounts/{email} — permanently removes the sending
  // mailbox from Instantly. Requires accounts:update / accounts:all scope.
  async deleteAccount(email: string): Promise<void> {
    await this.request<unknown>(
      `/accounts/${encodeURIComponent(email)}`,
      { method: "DELETE" },
    );
  }

  async getAllAccountCampaignMappingsForEmail(email: string): Promise<InstantlyAccountCampaignMapping[]> {
    const all: InstantlyAccountCampaignMapping[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.getAccountCampaignMappings(email, cursor);
      all.push(...response.items);
      cursor = response.next_starting_after;
    } while (cursor);
    return all;
  }

  // ===== EMAILS / UNIBOX =====

  async getEmails(
    campaignId?: string,
    emailType?: "sent" | "received" | "all",
    startingAfter?: string,
    limit = 100
  ): Promise<InstantlyEmailListResponse> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (campaignId) params.set("campaign_id", campaignId);
    if (emailType) params.set("email_type", emailType);
    if (startingAfter) params.set("starting_after", startingAfter);
    return this.request<InstantlyEmailListResponse>(
      `/emails?${params.toString()}`
    );
  }

  async getAllEmails(
    campaignId?: string,
    emailType?: "sent" | "received" | "all"
  ): Promise<InstantlyEmail[]> {
    const all: InstantlyEmail[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.getEmails(campaignId, emailType, cursor);
      all.push(...response.items);
      cursor = response.next_starting_after;
    } while (cursor);
    return all;
  }

  // Fetch a single email by id. Used by the webhook handler to enrich the
  // `reply_received` event (the webhook body is sparse; the /emails/{id}
  // response has 41 fields including `eaccount`, `thread_id`, body, etc.).
  async getEmail(emailId: string): Promise<InstantlyEmail> {
    return this.request<InstantlyEmail>(`/emails/${emailId}`);
  }

  // Send a reply through Instantly's native reply endpoint.
  //
  // POST /api/v2/emails/reply  — see
  // https://developer.instantly.ai/api-reference/email/reply-to-an-email
  //
  // Required body fields: eaccount, reply_to_uuid, subject, body.
  // The response is the created Email object (has id, thread_id, message_id).
  async replyViaEmailsApi(request: InstantlyReplyRequest): Promise<InstantlyEmail> {
    return this.request<InstantlyEmail>("/emails/reply", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  // ===== WEBHOOKS =====

  // Register the given URL to receive Instantly webhook events.
  //
  // POST /api/v2/webhooks  — see
  // https://developer.instantly.ai/api-reference/webhook/create-a-webhook
  //
  // We subscribe once per organization with event_type="all_events" and
  // store the returned id on organizations.instantly_webhook_id. Re-calling
  // with the same URL just creates a duplicate subscription on Instantly's
  // side — the admin UI guards against that by disabling the button when
  // we already have a webhook id.
  async createWebhook(request: InstantlyWebhookCreate): Promise<InstantlyWebhookResponse> {
    return this.request<InstantlyWebhookResponse>("/webhooks", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  // ===== CONNECTION TEST =====

  async testConnection(): Promise<boolean> {
    try {
      await this.listCampaigns();
      return true;
    } catch {
      return false;
    }
  }
}
