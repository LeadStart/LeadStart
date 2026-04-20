/**
 * Shared admin page queries. Each admin page exports its SWR key + fetcher
 * here so the `<AdminPrefetcher />` can warm all of them in parallel on
 * dashboard mount — later navigations get instant cache hits.
 *
 * Whenever you change one of these fetchers, the matching page and the
 * prefetcher both pick up the change automatically.
 */

import type { createClient } from "@/lib/supabase/client";
import { analyzeStepHealth } from "@/lib/kpi/step-health";
import { calculateMetrics } from "@/lib/kpi/calculator";
import type {
  Campaign,
  Client,
  ClientUser,
  CampaignSnapshot,
  CampaignStepMetric,
  KPIMetrics,
  StepHealthAlert,
  Contact,
  LeadFeedback,
  WebhookEvent,
  Task,
} from "@/types/app";

type SupabaseClient = ReturnType<typeof createClient>;

// ---------- Overview ----------
export const ADMIN_OVERVIEW_KEY = "admin-overview";

export type AdminOverviewCard = {
  client: Client;
  clientCampaigns: Campaign[];
  activeCampaigns: Campaign[];
  metrics: KPIMetrics;
  health: "good" | "warning" | "bad" | "none";
  stepAlerts: StepHealthAlert[];
};

export type AdminOverviewData = {
  cards: AdminOverviewCard[];
  totalActive: number;
  allStepAlerts: StepHealthAlert[];
};

export async function fetchAdminOverview(
  supabase: SupabaseClient,
): Promise<AdminOverviewData> {
  const [clientsRes, campaignsRes, snapshotsRes, stepMetricsRes] =
    await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase.from("campaigns").select("*"),
      supabase
        .from("campaign_snapshots")
        .select("*")
        .gte(
          "snapshot_date",
          new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
        )
        .order("snapshot_date", { ascending: false }),
      supabase
        .from("campaign_step_metrics")
        .select("*")
        .order("period_start", { ascending: true }),
    ]);
  const clients = (clientsRes.data || []) as Client[];
  const campaigns = (campaignsRes.data || []) as Campaign[];
  const snapshots = (snapshotsRes.data || []) as CampaignSnapshot[];
  const stepMetrics = (stepMetricsRes.data || []) as CampaignStepMetric[];

  const campaignInfoMap = new Map<
    string,
    { id: string; name: string; client_name: string }
  >();
  for (const camp of campaigns) {
    const client = clients.find((c) => c.id === camp.client_id);
    campaignInfoMap.set(camp.id, {
      id: camp.id,
      name: camp.name,
      client_name: client?.name || "Unknown",
    });
  }

  const allStepAlerts = analyzeStepHealth(stepMetrics, campaignInfoMap);

  const cards: AdminOverviewCard[] = clients.map((client) => {
    const clientCampaigns = campaigns.filter((c) => c.client_id === client.id);
    const activeCampaigns = clientCampaigns.filter((c) => c.status === "active");
    const campaignIds = clientCampaigns.map((c) => c.id);
    const clientSnapshots = snapshots.filter((s) =>
      campaignIds.includes(s.campaign_id),
    );
    const metrics = calculateMetrics(clientSnapshots);

    const clientStepAlerts = allStepAlerts.filter((a) =>
      campaignIds.includes(a.campaign_id),
    );

    let health: "good" | "warning" | "bad" | "none";
    if (metrics.emails_sent === 0) {
      health = "none";
    } else if (clientStepAlerts.some((a) => a.severity === "critical")) {
      health = "bad";
    } else if (clientStepAlerts.length > 0) {
      health = "warning";
    } else {
      health = "good";
    }

    return {
      client,
      clientCampaigns,
      activeCampaigns,
      metrics,
      health,
      stepAlerts: clientStepAlerts,
    };
  });
  const healthOrder = { bad: 0, warning: 1, good: 2, none: 3 };
  cards.sort((a, b) => healthOrder[a.health] - healthOrder[b.health]);
  return {
    cards,
    totalActive: campaigns.filter((c) => c.status === "active").length,
    allStepAlerts,
  };
}

// ---------- Clients ----------
export const ADMIN_CLIENTS_KEY = "admin-clients";

export async function fetchAdminClients(supabase: SupabaseClient) {
  const [clientsRes, campaignsRes, clientUsersRes] = await Promise.all([
    supabase.from("clients").select("*").order("name"),
    supabase.from("campaigns").select("*"),
    supabase.from("client_users").select("*"),
  ]);
  return {
    clients: (clientsRes.data || []) as Client[],
    campaigns: (campaignsRes.data || []) as Campaign[],
    clientUsers: (clientUsersRes.data || []) as ClientUser[],
  };
}

// ---------- Campaigns ----------
export const ADMIN_CAMPAIGNS_KEY = "admin-campaigns";

export async function fetchAdminCampaigns(supabase: SupabaseClient) {
  const [campaignsRes, clientsRes, snapshotsRes] = await Promise.all([
    supabase
      .from("campaigns")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase.from("clients").select("*"),
    supabase
      .from("campaign_snapshots")
      .select("*")
      .gte(
        "snapshot_date",
        new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
      ),
  ]);
  return {
    campaigns: (campaignsRes.data || []) as Campaign[],
    clients: (clientsRes.data || []) as Client[],
    snapshots: (snapshotsRes.data || []) as CampaignSnapshot[],
  };
}

// ---------- Contacts (admin list) ----------
export const ADMIN_CONTACTS_KEY = "admin-contacts";

export async function fetchAdminContacts(supabase: SupabaseClient) {
  const [contactsRes, clientsRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase.from("clients").select("id, name"),
  ]);
  return {
    contacts: (contactsRes.data || []) as Contact[],
    clients: (clientsRes.data || []) as { id: string; name: string }[],
  };
}

// ---------- Feedback ----------
export const ADMIN_FEEDBACK_KEY = "admin-feedback";

export async function fetchAdminFeedback(supabase: SupabaseClient) {
  const [feedbackRes, campaignsRes] = await Promise.all([
    supabase
      .from("lead_feedback")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("campaigns").select("id, name"),
  ]);
  return {
    feedback: (feedbackRes.data || []) as LeadFeedback[],
    campaigns: (campaignsRes.data || []) as Pick<Campaign, "id" | "name">[],
  };
}

// ---------- Webhooks (Events) ----------
export const ADMIN_WEBHOOKS_KEY = "admin-webhooks";

export async function fetchAdminWebhooks(supabase: SupabaseClient) {
  const { data } = await supabase
    .from("webhook_events")
    .select("*")
    .order("received_at", { ascending: false })
    .limit(100);
  return (data || []) as WebhookEvent[];
}

// ---------- Tasks ----------
export const ADMIN_TASKS_KEY = "admin-tasks";

export async function fetchAdminTasks(supabase: SupabaseClient) {
  const res = await supabase
    .from("tasks")
    .select("*")
    .order("created_at", { ascending: false });
  return (res.data || []) as Task[];
}

// ---------- API-route-backed pages ----------
// Keys used by useApiQuery (SWR key == URL path) so the prefetcher and the
// page share the same cache slot.
export const API_INBOX_HEALTH_PATH = "/api/instantly/inbox-health";
export const API_BILLING_DATA_PATH = "/api/billing/data";

// ---------- Prospects (contacts + pipeline) ----------
export const ADMIN_CONTACTS_PIPELINE_KEY = "admin-contacts-with-pipeline";

export async function fetchAdminContactsPipeline(supabase: SupabaseClient) {
  // Prospects kanban is LeadStart's own sales funnel — exclude contacts
  // that belong to a client (those are campaign recipients, not leads
  // we are selling to).
  const res = await supabase.from("contacts").select("*").is("client_id", null);
  return ((res.data || []) as Contact[]).slice().sort((a, b) => {
    if (a.pipeline_sort_order !== b.pipeline_sort_order)
      return a.pipeline_sort_order - b.pipeline_sort_order;
    return (b.updated_at || "").localeCompare(a.updated_at || "");
  });
}
