import type {
  WarmforgeMailbox,
  WarmforgeMailboxList,
} from "./types";

// Warmforge public API host. Different host from Salesforge (api.salesforge.ai)
// even though the two products share an account / mailbox sync surface.
const BASE_URL = "https://api.warmforge.ai/public/v1";

export class WarmforgeClient {
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

    // Mirroring Salesforge's auth convention (raw key, no Bearer prefix)
    // since Warmforge is the same vendor. The cascade test will confirm
    // — if Warmforge insists on Bearer, the failure will be clear from
    // the 401 body and we adjust here.
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
            `Warmforge API error ${response.status}: ${errorBody}`
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

    throw lastError || new Error("Warmforge API request failed");
  }

  // GET /mailboxes — paginated. Used by the connection-test button on
  // /admin/settings/api with page_size=1, and by the Inbox Health page
  // with the full pagination loop in getAllMailboxes.
  async listMailboxes(page = 1, pageSize = 100): Promise<WarmforgeMailbox[]> {
    const response = await this.request<WarmforgeMailboxList | WarmforgeMailbox[]>(
      `/mailboxes?page=${page}&page_size=${pageSize}`
    );
    return Array.isArray(response) ? response : (response.items ?? []);
  }

  async getAllMailboxes(): Promise<WarmforgeMailbox[]> {
    const all: WarmforgeMailbox[] = [];
    const pageSize = 100;
    for (let page = 1; ; page++) {
      const items = await this.listMailboxes(page, pageSize);
      if (items.length === 0) break;
      all.push(...items);
      if (items.length < pageSize) break;
    }
    return all;
  }

  // GET /mailboxes/{address} — per-mailbox detail (heat score, DNS
  // verification, blacklist, warmup stats).
  async getMailbox(address: string): Promise<WarmforgeMailbox> {
    return this.request<WarmforgeMailbox>(
      `/mailboxes/${encodeURIComponent(address)}`
    );
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.listMailboxes(1, 1);
      return true;
    } catch {
      return false;
    }
  }
}
