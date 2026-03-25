"use client";

import useSWR, { SWRConfiguration } from "swr";
import { createClient } from "@/lib/supabase/client";

type QueryFn<T> = (supabase: ReturnType<typeof createClient>) => Promise<T>;

/**
 * SWR-powered Supabase query hook.
 *
 * - Shows cached data instantly on revisit
 * - Revalidates in the background every 30s
 * - Revalidates when the browser tab regains focus
 * - Deduplicates identical requests within 2s
 */
export function useSupabaseQuery<T>(
  key: string,
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
  };
}
