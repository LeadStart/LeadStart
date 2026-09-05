"use client";

import useSWR, { SWRConfiguration } from "swr";
import { createClient } from "@/lib/supabase/client";

type QueryFn<T> = (supabase: ReturnType<typeof createClient>) => Promise<T>;

/**
 * SWR-powered Supabase query hook.
 *
 * - Shows cached data instantly on revisit (cache survives client navigation)
 * - Does NOT auto-revalidate on focus/reconnect/stale: call `refetch()` after a
 *   mutation to refresh. This keeps navigation cheap on a small DB.
 * - Deduplicates identical requests within 5s
 * - Pass `key = null` to pause the query (SWR won't call the fetcher). Useful for
 *   lazy/on-demand queries, e.g. only fetch once a search box is focused.
 */
export function useSupabaseQuery<T>(
  key: string | null,
  queryFn: QueryFn<T>,
  options?: SWRConfiguration
) {
  const { data, error, isLoading, isValidating, mutate } = useSWR<T>(
    key,
    async () => {
      const supabase = createClient();
      return queryFn(supabase);
    },
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      revalidateOnReconnect: false,
      dedupingInterval: 5_000,
      ...options,
    }
  );

  return {
    data: data ?? null,
    loading: isLoading,
    refreshing: isValidating && !isLoading,
    error: error?.message ?? null,
    refetch: mutate,
    /** Optimistically update cached data without revalidation */
    setData: (updater: (prev: T | null) => T) => {
      mutate((prev?: T) => updater(prev ?? null), { revalidate: false });
    },
  };
}
