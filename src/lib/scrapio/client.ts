import type {
  ScrapioCategory,
  ScrapioLocation,
  ScrapioLocationType,
  ScrapioSearchParams,
  ScrapioSearchResponse,
  ScrapioSubscription,
} from "./types";
import { buildFilterParams } from "./filters";

const BASE_URL = "https://scrap.io/api/v1";
const DEFAULT_COUNTRY_CODE = "us";

export class ScrapioClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(
    endpoint: string,
    init: RequestInit & { searchParams?: Record<string, string | number> } = {},
  ): Promise<T> {
    const { searchParams, ...rest } = init;
    const qs = searchParams
      ? "?" +
        new URLSearchParams(
          Object.entries(searchParams).map(([k, v]) => [k, String(v)]),
        ).toString()
      : "";
    const url = `${BASE_URL}${endpoint}${qs}`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          ...rest,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...rest.headers,
          },
        });

        if (response.status === 429) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Scrap.io API error ${response.status}: ${body}`);
        }

        return (await response.json()) as T;
      } catch (err) {
        lastError = err as Error;
        if (attempt < 2) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError ?? new Error("Scrap.io API request failed");
  }

  async getSubscription(): Promise<ScrapioSubscription> {
    return this.request<ScrapioSubscription>("/subscription");
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getSubscription();
      return true;
    } catch {
      return false;
    }
  }

  async searchLocations(params: {
    type: ScrapioLocationType;
    search_term: string;
    admin1_code?: string;
  }): Promise<ScrapioLocation[]> {
    const searchParams: Record<string, string> = {
      country_code: DEFAULT_COUNTRY_CODE,
      type: params.type,
      search_term: params.search_term,
    };
    if (params.admin1_code) searchParams.admin1_code = params.admin1_code;
    const data = await this.request<unknown>("/gmap/locations", {
      searchParams,
    });
    return Array.isArray(data) ? (data as ScrapioLocation[]) : [];
  }

  async searchTypes(searchTerm: string): Promise<ScrapioCategory[]> {
    const data = await this.request<unknown>("/gmap/types", {
      searchParams: { search_term: searchTerm, locale: "en" },
    });
    return Array.isArray(data) ? (data as ScrapioCategory[]) : [];
  }

  // Single page of /gmap/search. Pagination (looping on
  // response.meta.next_cursor) is the caller's responsibility — that lets
  // the caller enforce a page cap and per-request budget.
  async search(params: ScrapioSearchParams): Promise<ScrapioSearchResponse> {
    const filterParams = buildFilterParams(params.filters);

    const searchParams: Record<string, string | number> = {
      country_code: DEFAULT_COUNTRY_CODE,
      type: params.type,
      admin1_code: params.admin1_code,
      per_page: params.per_page ?? 50,
      ...filterParams,
    };
    if (params.admin2_code) searchParams.admin2_code = params.admin2_code;
    if (params.city) searchParams.city = params.city;
    if (params.cursor) searchParams.cursor = params.cursor;

    return this.request<ScrapioSearchResponse>("/gmap/search", {
      searchParams,
    });
  }

  // Adds entries to a Scrap.io blacklist. Future searches skip blacklisted
  // items AND don't count them toward credits.
  //
  // Per Scrap.io docs: max 100 entries per call. We chunk automatically
  // so the caller can pass any size array. Failures on individual chunks
  // are logged but don't block the rest — the worst case is paying credits
  // for a few items next time, which is recoverable.
  async blacklistAdd(
    listName: string,
    type: "google_id" | "place_id" | "domain" | "email",
    ids: string[],
  ): Promise<{ added: number; failed: number }> {
    const unique = Array.from(new Set(ids.filter((id) => id && id.length > 0)));
    let added = 0;
    let failed = 0;
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      try {
        await this.request<unknown>(
          `/blacklists/${encodeURIComponent(listName)}`,
          {
            method: "POST",
            body: JSON.stringify({ type, data: chunk }),
          },
        );
        added += chunk.length;
      } catch (err) {
        console.error(
          `[scrapio] blacklist chunk ${i}-${i + chunk.length} failed:`,
          err,
        );
        failed += chunk.length;
      }
    }
    return { added, failed };
  }

  // Wipes an entire blacklist. Used by the "Reset blacklist" admin action
  // when the user wants to re-pull a region they scraped previously.
  async blacklistDelete(listName: string): Promise<void> {
    await this.request<unknown>(
      `/blacklists/${encodeURIComponent(listName)}`,
      { method: "DELETE" },
    );
  }
}
