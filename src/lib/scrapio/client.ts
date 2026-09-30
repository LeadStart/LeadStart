import type {
  ScrapioCategory,
  ScrapioLocation,
  ScrapioLocationType,
  ScrapioSearchParams,
  ScrapioSearchResponse,
  ScrapioSubscription,
} from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildFilterParams } from "./filters";

const BASE_URL = "https://scrap.io/api/v1";
const DEFAULT_COUNTRY_CODE = "us";

// Every /gmap/* call (search pages, free skip_data counts, location/type
// lookups) counts against Scrap.io's fair-use search quota. ~1,800 of them in
// three days locked the account on 2026-09-26 until support unlocked it. So
// each one first claims a slot in the shared search log (migration 00135,
// claim_scrapio_search): 150 per 24 hours, 400 per 7 days, 1,000 per 30 days
// per organization, shared with the TuBe pipeline skill. No claim, no search.
export type ScrapioSearchGuard = {
  admin: SupabaseClient;
  organizationId: string;
  /** Who is searching, for the log, e.g. "app:cron/run-prospect-searches". */
  source: string;
};

export class ScrapioSearchLimitError extends Error {}

type SearchBudget = {
  ok?: boolean;
  day: number;
  week: number;
  month: number;
  limits: { day: number; week: number; month: number };
  left: number;
};

export class ScrapioClient {
  private apiKey: string;
  private guard?: ScrapioSearchGuard;

  constructor(apiKey: string, guard?: ScrapioSearchGuard) {
    this.apiKey = apiKey;
    this.guard = guard;
  }

  private async claimSearch(
    endpoint: string,
    searchParams?: Record<string, string | number>,
  ): Promise<void> {
    if (!this.guard) {
      throw new ScrapioSearchLimitError(
        `Scrap.io ${endpoint} not sent: this client has no search guard, and every search must be logged.`,
      );
    }
    const { data, error } = await this.guard.admin.rpc("claim_scrapio_search", {
      p_organization_id: this.guard.organizationId,
      p_endpoint: endpoint,
      p_source: this.guard.source,
      p_detail: searchParams ?? null,
    });
    if (error || !data) {
      throw new ScrapioSearchLimitError(
        `Scrap.io ${endpoint} not sent: couldn't log it in the search log (${error?.message ?? "no answer"}).`,
      );
    }
    const b = data as SearchBudget;
    if (!b.ok) {
      throw new ScrapioSearchLimitError(
        `Scrap.io search limit reached, nothing sent: ${b.day}/${b.limits.day} in 24 hours, ` +
          `${b.week}/${b.limits.week} in 7 days, ${b.month}/${b.limits.month} in 30 days.`,
      );
    }
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

    // A search is sent once: a retry is another search against the quota.
    // Other calls retry only a network failure or a 5xx. A 4xx is final,
    // above all 403 (the fair-use lock) and 429: never retry into a lock.
    const isSearch = endpoint.startsWith("/gmap/");
    const attempts = isSearch ? 1 : 3;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
      }
      if (isSearch) await this.claimSearch(endpoint, searchParams);

      let response: Response;
      try {
        response = await fetch(url, {
          ...rest,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...rest.headers,
          },
        });
      } catch (err) {
        lastError = err as Error;
        continue;
      }

      if (response.ok) return (await response.json()) as T;

      const body = await response.text();
      lastError = new Error(`Scrap.io API error ${response.status}: ${body}`);
      if (response.status < 500) throw lastError;
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
  // response.meta.next_cursor) is the caller's responsibility: that lets
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
  // are logged but don't block the rest: the worst case is paying credits
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
