"use client";

import useSWR, { SWRConfiguration } from "swr";
import { appUrl } from "@/lib/api-url";

async function apiFetcher<T>(path: string): Promise<T> {
  const res = await fetch(appUrl(path));
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON body; fall back to status message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/**
 * SWR-powered fetch hook for our internal API routes. Mirrors
 * `useSupabaseQuery` so the data lifecycle (loading/refreshing/error/refetch)
 * feels identical at the call site. Key is the path itself, so the
 * prefetcher and pages naturally share the same cache entry.
 */
export function useApiQuery<T>(path: string | null, options?: SWRConfiguration) {
  const { data, error, isLoading, isValidating, mutate } = useSWR<T>(
    path,
    (p: string) => apiFetcher<T>(p),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      revalidateOnReconnect: false,
      dedupingInterval: 5_000,
      ...options,
    },
  );

  return {
    data: data ?? null,
    loading: isLoading,
    refreshing: isValidating && !isLoading,
    error: error instanceof Error ? error.message : (error ?? null),
    refetch: mutate,
  };
}
