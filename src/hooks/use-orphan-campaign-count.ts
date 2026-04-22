"use client";

import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import type { AppRole } from "@/types/app";

// Shared SWR key so pages that mutate orphan state (e.g. the /unlinked page
// after a successful link) can bust this cache via mutate().
export const ORPHAN_CAMPAIGN_COUNT_KEY = "orphan-campaigns-count";

/**
 * Lightweight count of campaigns with client_id IS NULL, used by the sidebar
 * badge. Gated to admin roles client-side — clients get 0 without issuing a
 * round-trip (RLS would return 0 anyway).
 */
export function useOrphanCampaignCount(role: AppRole | null | undefined): number {
  const isAdmin = role === "owner" || role === "va";
  const { data } = useSWR<number>(
    isAdmin ? ORPHAN_CAMPAIGN_COUNT_KEY : null,
    async () => {
      const supabase = createClient();
      const { count } = await supabase
        .from("campaigns")
        .select("id", { count: "exact", head: true })
        .is("client_id", null);
      return count ?? 0;
    },
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      revalidateOnReconnect: false,
      dedupingInterval: 30_000,
    },
  );
  return data ?? 0;
}
