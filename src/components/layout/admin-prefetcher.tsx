"use client";

import { useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import { createClient } from "@/lib/supabase/client";
import {
  ADMIN_OVERVIEW_KEY,
  ADMIN_CLIENTS_KEY,
  ADMIN_CAMPAIGNS_KEY,
  ADMIN_CONTACTS_KEY,
  ADMIN_FEEDBACK_KEY,
  ADMIN_TASKS_KEY,
  fetchAdminOverview,
  fetchAdminClients,
  fetchAdminCampaigns,
  fetchAdminContacts,
  fetchAdminFeedback,
  fetchAdminTasks,
} from "@/lib/admin-queries";

/**
 * Warms the SWR cache for the common admin tabs so later sidebar clicks render
 * from cache instead of paying a fresh round-trip. Renders nothing.
 *
 * Two deliberate constraints, both learned from this being a first-paint drag:
 *
 * 1. Deferred until the browser is idle (requestIdleCallback, 1.5s fallback) so
 *    the page you're actually looking at gets the connection pool to itself
 *    first.
 * 2. Warmed SEQUENTIALLY, one key at a time. Firing all fetchers at once put a
 *    burst of heavy queries on a small Supabase instance in parallel with the
 *    current page's own queries: they queued behind each other and made the
 *    click you just made feel slow. One-at-a-time keeps the DB unsaturated.
 *
 * Only the light-to-medium list keys are warmed. The prospects pipeline
 * (select * incl. the enrichment_data JSONB) and billing (5-table join) are
 * heavy and rarely the next click, so they fetch on demand instead.
 *
 * Keys already in the SWR cache (e.g. the current page already fetched one) are
 * skipped, so warming never re-fetches data the app already has.
 */
const PREFETCH_FALLBACK_DELAY_MS = 1500;

const WARM_TASKS: ReadonlyArray<
  readonly [string, (supabase: ReturnType<typeof createClient>) => Promise<unknown>]
> = [
  [ADMIN_OVERVIEW_KEY, fetchAdminOverview],
  [ADMIN_CLIENTS_KEY, fetchAdminClients],
  [ADMIN_CAMPAIGNS_KEY, fetchAdminCampaigns],
  [ADMIN_CONTACTS_KEY, fetchAdminContacts],
  [ADMIN_FEEDBACK_KEY, fetchAdminFeedback],
  [ADMIN_TASKS_KEY, fetchAdminTasks],
];

export function AdminPrefetcher() {
  const [ready, setReady] = useState(false);
  const { cache, mutate } = useSWRConfig();

  useEffect(() => {
    const win = window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    let idleHandle: number | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (typeof win.requestIdleCallback === "function") {
      idleHandle = win.requestIdleCallback(() => setReady(true), {
        timeout: PREFETCH_FALLBACK_DELAY_MS * 2,
      });
    } else {
      timeoutHandle = setTimeout(() => setReady(true), PREFETCH_FALLBACK_DELAY_MS);
    }

    return () => {
      if (
        idleHandle !== undefined &&
        typeof win.cancelIdleCallback === "function"
      ) {
        win.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    (async () => {
      const supabase = createClient();
      for (const [key, fetcher] of WARM_TASKS) {
        if (cancelled) return;
        // Skip anything already cached (the current page may own this key).
        if (cache.get(key)?.data !== undefined) continue;
        try {
          // Populate the cache slot without triggering a follow-up revalidation.
          await mutate(key, () => fetcher(supabase), { revalidate: false });
        } catch {
          // Best-effort cache warming: a failure just means this tab fetches
          // on click, same as if the prefetcher weren't mounted.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, cache, mutate]);

  return null;
}
