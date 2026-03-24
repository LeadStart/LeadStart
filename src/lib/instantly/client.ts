import type {
  InstantlyCampaign,
  InstantlyCampaignListResponse,
  InstantlyAnalytics,
  InstantlyAnalyticsResponse,
  InstantlyLead,
  InstantlyLeadListResponse,
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

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
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

  // ===== LEADS =====

  async listLeads(
    campaignId: string,
    startingAfter?: string
  ): Promise<InstantlyLeadListResponse> {
    const params = new URLSearchParams({
      campaign_id: campaignId,
      limit: "100",
    });
    if (startingAfter) params.set("starting_after", startingAfter);

    return this.request<InstantlyLeadListResponse>(
      `/leads?${params.toString()}`
    );
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
