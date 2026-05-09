"use client";

import { useEffect, useState } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  ADMIN_OVERVIEW_KEY,
  ADMIN_CLIENTS_KEY,
  ADMIN_CAMPAIGNS_KEY,
  ADMIN_CONTACTS_KEY,
  ADMIN_FEEDBACK_KEY,
  ADMIN_TASKS_KEY,
  ADMIN_CONTACTS_PIPELINE_KEY,
  API_BILLING_DATA_PATH,
  fetchAdminOverview,
  fetchAdminClients,
  fetchAdminCampaigns,
  fetchAdminContacts,
  fetchAdminFeedback,
  fetchAdminTasks,
  fetchAdminContactsPipeline,
} from "@/lib/admin-queries";

/**
 * Warms the SWR cache for every admin tab so later sidebar clicks render
 * from cache instead of paying a fresh round-trip. Renders nothing.
 *
 * Deferred until the browser is idle: firing 8 background queries on
 * mount competes with the current page's own queries for the browser's
 * ~6-connection-per-origin limit, which made first paint feel slow. We
 * wait for `requestIdleCallback` (or a 1500ms fallback) so the page
 * being viewed gets the connection pool to itself, then warm the cache
 * once it's settled.
 *
 * Only mount this for admin users — client users never navigate to these
 * keys so warming them would waste bandwidth.
 */
const PREFETCH_FALLBACK_DELAY_MS = 1500;

export function AdminPrefetcher() {
  const [ready, setReady] = useState(false);

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

  if (!ready) return null;
  return <DeferredPrefetchQueries />;
}

function DeferredPrefetchQueries() {
  useSupabaseQuery(ADMIN_OVERVIEW_KEY, fetchAdminOverview);
  useSupabaseQuery(ADMIN_CLIENTS_KEY, fetchAdminClients);
  useSupabaseQuery(ADMIN_CAMPAIGNS_KEY, fetchAdminCampaigns);
  useSupabaseQuery(ADMIN_CONTACTS_KEY, fetchAdminContacts);
  useSupabaseQuery(ADMIN_FEEDBACK_KEY, fetchAdminFeedback);
  useSupabaseQuery(ADMIN_TASKS_KEY, fetchAdminTasks);
  useSupabaseQuery(ADMIN_CONTACTS_PIPELINE_KEY, fetchAdminContactsPipeline);

  // Billing pulls plans+quotes+subs+invoices+clients in one round-trip.
  useApiQuery(API_BILLING_DATA_PATH);

  return null;
}
