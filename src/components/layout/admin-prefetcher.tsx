"use client";

import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  ADMIN_OVERVIEW_KEY,
  ADMIN_CLIENTS_KEY,
  ADMIN_CAMPAIGNS_KEY,
  ADMIN_CONTACTS_KEY,
  ADMIN_FEEDBACK_KEY,
  ADMIN_WEBHOOKS_KEY,
  ADMIN_TASKS_KEY,
  ADMIN_CONTACTS_PIPELINE_KEY,
  API_INBOX_HEALTH_PATH,
  API_BILLING_DATA_PATH,
  fetchAdminOverview,
  fetchAdminClients,
  fetchAdminCampaigns,
  fetchAdminContacts,
  fetchAdminFeedback,
  fetchAdminWebhooks,
  fetchAdminTasks,
  fetchAdminContactsPipeline,
} from "@/lib/admin-queries";

/**
 * Warms the SWR cache for every admin tab on first dashboard mount. Renders
 * nothing; the hooks just fire their fetchers and populate the shared cache
 * by key. When the user later clicks a sidebar link, that page's
 * useSupabaseQuery / useApiQuery hits the cache and renders instantly
 * instead of paying a fresh round-trip.
 *
 * Only mount this for admin users — client users never navigate to these
 * keys so warming them would waste bandwidth.
 */
export function AdminPrefetcher() {
  // Supabase-backed pages
  useSupabaseQuery(ADMIN_OVERVIEW_KEY, fetchAdminOverview);
  useSupabaseQuery(ADMIN_CLIENTS_KEY, fetchAdminClients);
  useSupabaseQuery(ADMIN_CAMPAIGNS_KEY, fetchAdminCampaigns);
  useSupabaseQuery(ADMIN_CONTACTS_KEY, fetchAdminContacts);
  useSupabaseQuery(ADMIN_FEEDBACK_KEY, fetchAdminFeedback);
  useSupabaseQuery(ADMIN_WEBHOOKS_KEY, fetchAdminWebhooks);
  useSupabaseQuery(ADMIN_TASKS_KEY, fetchAdminTasks);
  useSupabaseQuery(ADMIN_CONTACTS_PIPELINE_KEY, fetchAdminContactsPipeline);

  // API-route-backed pages (Inbox Health hits Instantly.ai; Billing pulls
  // plans+quotes+subs+invoices+clients in one round-trip). Both are slow
  // first-visits — prefetching in the background hides the latency.
  useApiQuery(API_INBOX_HEALTH_PATH);
  useApiQuery(API_BILLING_DATA_PATH);

  return null;
}
