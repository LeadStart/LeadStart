import type { ApifyRun, ApifyUser } from "./types";

// Minimal Apify REST v2 client. Mirrors the style of src/lib/scrapio/client.ts
// (plain fetch, 3 attempts, exponential backoff) with one deliberate rule:
// startActorRun retries ONLY on HTTP 429: never on a thrown network error,
// because a POST that may already have reached Apify must not be replayed
// (that would start a second paid actor run). Reads (GET) retry on network
// errors and 5xx as usual.
//
// The token is sent as `Authorization: Bearer` so it never lands in a URL or
// a log line.

const BASE_URL = "https://api.apify.com/v2";

export class ApifyApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Apify API error ${status}: ${body}`);
    this.name = "ApifyApiError";
  }
}

interface RequestOpts {
  method?: string;
  body?: unknown;
  searchParams?: Record<string, string | number | boolean>;
  // false for run starts: do not replay a POST that may have landed.
  retryOnNetworkError?: boolean;
}

export class ApifyClient {
  constructor(private token: string) {}

  private buildUrl(path: string, searchParams?: RequestOpts["searchParams"]): string {
    const qs = searchParams
      ? "?" +
        new URLSearchParams(
          Object.entries(searchParams).map(([k, v]) => [k, String(v)]),
        ).toString()
      : "";
    return `${BASE_URL}${path}${qs}`;
  }

  private async request<T>(
    path: string,
    opts: RequestOpts = {},
  ): Promise<{ body: T; headers: Headers }> {
    const { method = "GET", body, searchParams, retryOnNetworkError = true } = opts;
    const url = this.buildUrl(path, searchParams);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

        if (response.status === 429) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Retry transient server errors on idempotent-ish calls.
        if (response.status >= 500 && retryOnNetworkError && attempt < 2) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          throw new ApifyApiError(response.status, text.slice(0, 500));
        }

        const text = await response.text();
        const parsed = text ? (JSON.parse(text) as T) : ({} as T);
        return { body: parsed, headers: response.headers };
      } catch (err) {
        // ApifyApiError is a definitive HTTP failure: do not retry it.
        if (err instanceof ApifyApiError) throw err;
        lastError = err as Error;
        // A thrown fetch error means the request may or may not have landed.
        // For run starts (retryOnNetworkError=false) we surface immediately.
        if (!retryOnNetworkError) throw lastError;
        if (attempt < 2) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError ?? new Error("Apify API request failed");
  }

  async getMe(): Promise<ApifyUser> {
    const { body } = await this.request<{ data: ApifyUser }>("/users/me");
    return body.data;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getMe();
      return true;
    } catch {
      return false;
    }
  }

  // Start an actor run. `actorId` is the "username~actor-name" form (the `~`
  // must survive encoding, which encodeURIComponent preserves).
  async startActorRun(
    actorId: string,
    input: unknown,
    opts: {
      waitForFinishSec?: number;
      timeoutSec?: number;
      memoryMbytes?: number;
      // Hard per-run charge ceiling the PLATFORM enforces: Apify aborts the run
      // once billed charges reach this dollar amount. The single guardrail that
      // turns a semantics surprise (the 2026-08-30 $14.17 per-place-cap incident)
      // into a bounded loss. Every caller should pass one derived from the run's
      // own worst-case estimate. Omitted → Apify auto-caps at the ENTIRE
      // remaining monthly credit, which is what let $0.40 of intent bill $14.
      maxTotalChargeUsd?: number;
    } = {},
  ): Promise<ApifyRun> {
    const searchParams: Record<string, string | number> = {};
    if (opts.waitForFinishSec != null) {
      searchParams.waitForFinish = Math.max(0, Math.min(60, Math.round(opts.waitForFinishSec)));
    }
    if (opts.timeoutSec != null) searchParams.timeout = Math.round(opts.timeoutSec);
    if (opts.memoryMbytes != null) searchParams.memory = Math.round(opts.memoryMbytes);
    if (opts.maxTotalChargeUsd != null && Number.isFinite(opts.maxTotalChargeUsd)) {
      // Round UP to the cent so a fractional estimate never caps below the work
      // we actually intend to let through.
      searchParams.maxTotalChargeUsd = Math.ceil(opts.maxTotalChargeUsd * 100) / 100;
    }

    const { body } = await this.request<{ data: ApifyRun }>(
      `/acts/${encodeURIComponent(actorId)}/runs`,
      { method: "POST", body: input, searchParams, retryOnNetworkError: false },
    );
    return body.data;
  }

  async getRun(runId: string): Promise<ApifyRun> {
    const { body } = await this.request<{ data: ApifyRun }>(
      `/actor-runs/${encodeURIComponent(runId)}`,
    );
    return body.data;
  }

  async abortRun(runId: string): Promise<ApifyRun> {
    const { body } = await this.request<{ data: ApifyRun }>(
      `/actor-runs/${encodeURIComponent(runId)}/abort`,
      { method: "POST" },
    );
    return body.data;
  }

  // Dataset metadata. `itemCount` is the number of items pushed so far and is
  // readable while the owning run is still in progress: Apify's documented
  // live-progress signal (the run object's own stats carry no item count).
  async getDatasetItemCount(datasetId: string): Promise<number | null> {
    const { body } = await this.request<{ data: { itemCount?: number } }>(
      `/datasets/${encodeURIComponent(datasetId)}`,
    );
    const n = body.data?.itemCount;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  }

  // ---- Account spend (authoritative, matches the Apify invoice) ----

  // The account's current monthly usage cycle: window, dollars used, and cap.
  // `usageUsd` is Apify's own authoritative cycle total (includes every run,
  // succeeded or not, plus storage): the number to trust over our per-run tallies.
  async getMonthlyUsage(): Promise<{
    cycleStart: string | null;
    cycleEnd: string | null;
    usageUsd: number | null;
    limitUsd: number | null;
  }> {
    const { body } = await this.request<{
      data: {
        monthlyUsageCycle?: { startAt?: string; endAt?: string };
        limits?: { maxMonthlyUsageUsd?: number };
        current?: { monthlyUsageUsd?: number };
      };
    }>("/users/me/limits");
    const d = body.data ?? {};
    return {
      cycleStart: d.monthlyUsageCycle?.startAt ?? null,
      cycleEnd: d.monthlyUsageCycle?.endAt ?? null,
      usageUsd: typeof d.current?.monthlyUsageUsd === "number" ? d.current.monthlyUsageUsd : null,
      limitUsd: typeof d.limits?.maxMonthlyUsageUsd === "number" ? d.limits.maxMonthlyUsageUsd : null,
    };
  }

  // Recent actor runs across the account (newest first), each with its real
  // charge: the raw material for the per-actor spend breakdown.
  async listRuns(
    opts: { limit?: number } = {},
  ): Promise<
    Array<{ id: string; actId: string; status: string; startedAt: string; usageTotalUsd: number | null }>
  > {
    const { body } = await this.request<{
      data: {
        items?: Array<{
          id: string;
          actId: string;
          status: string;
          startedAt: string;
          usageTotalUsd?: number | null;
        }>;
      };
    }>("/actor-runs", { searchParams: { desc: true, limit: opts.limit ?? 1000 } });
    return (body.data?.items ?? []).map((r) => ({
      id: r.id,
      actId: r.actId,
      status: r.status,
      startedAt: r.startedAt,
      usageTotalUsd: typeof r.usageTotalUsd === "number" ? r.usageTotalUsd : null,
    }));
  }

  // "username/actor-name" for an actor id (best-effort; falls back to the id).
  async getActorName(actId: string): Promise<string> {
    try {
      const { body } = await this.request<{ data: { username?: string; name?: string } }>(
        `/acts/${encodeURIComponent(actId)}`,
      );
      const d = body.data;
      return d?.username && d?.name ? `${d.username}/${d.name}` : actId;
    } catch {
      return actId;
    }
  }

  // One page of dataset items (bare JSON array). `total` comes from the
  // X-Apify-Pagination-Total header when present.
  async getDatasetItems<T = Record<string, unknown>>(
    datasetId: string,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<{ items: T[]; total: number | null }> {
    const { body, headers } = await this.request<T[]>(
      `/datasets/${encodeURIComponent(datasetId)}/items`,
      {
        searchParams: {
          clean: true,
          offset: opts.offset ?? 0,
          limit: opts.limit ?? 1000,
        },
      },
    );
    const totalRaw = headers.get("x-apify-pagination-total");
    const total = totalRaw != null ? Number(totalRaw) : null;
    return { items: Array.isArray(body) ? body : [], total: Number.isFinite(total) ? total : null };
  }

  // Page through an entire dataset (capped, so a runaway actor can't blow the
  // worker's memory/time budget).
  async getAllDatasetItems<T = Record<string, unknown>>(
    datasetId: string,
    opts: { pageSize?: number; maxItems?: number } = {},
  ): Promise<T[]> {
    const pageSize = opts.pageSize ?? 1000;
    const maxItems = opts.maxItems ?? 10_000;
    const out: T[] = [];
    let offset = 0;
    for (;;) {
      const { items, total } = await this.getDatasetItems<T>(datasetId, {
        offset,
        limit: pageSize,
      });
      out.push(...items);
      offset += items.length;
      if (items.length < pageSize) break; // short page = last page
      if (out.length >= maxItems) break;
      if (total != null && offset >= total) break;
    }
    return out.slice(0, maxItems);
  }
}
