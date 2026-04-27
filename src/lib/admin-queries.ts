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
import {
  HOT_REPLY_CLASSES,
  type Campaign,
  type Client,
  type ClientUser,
  type CampaignSnapshot,
  type CampaignStepMetric,
  type KPIMetrics,
  type StepHealthAlert,
  type Contact,
  type LeadFeedback,
  type WebhookEvent,
  type Task,
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
  // 7-day rollups derived from the 30-day snapshot pull we already do.
  // Surfaced on the dashboard KPI strip; no extra queries.
  repliesLast7d: number;
  emailsSentLast7d: number;
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

  // 7-day rollups across all snapshots already pulled. snapshot_date is
  // YYYY-MM-DD; compare as ISO date strings to avoid TZ surprises.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000)
    .toISOString()
    .split("T")[0];
  let repliesLast7d = 0;
  let emailsSentLast7d = 0;
  for (const snap of snapshots) {
    if (snap.snapshot_date >= sevenDaysAgo) {
      repliesLast7d += snap.replies ?? 0;
      emailsSentLast7d += snap.emails_sent ?? 0;
    }
  }

  return {
    cards,
    totalActive: campaigns.filter((c) => c.status === "active").length,
    allStepAlerts,
    repliesLast7d,
    emailsSentLast7d,
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

// ---------- Unlinked campaigns (B3 triage) ----------
export const ADMIN_UNLINKED_CAMPAIGNS_KEY = "admin-unlinked-campaigns";

export interface UnlinkedCampaignRow {
  campaign: Campaign;
  // Replies that WILL fire a notification the moment a client is linked:
  // classified (final_class set) and still waiting on notification_status.
  pending_notifications: number;
  // Every orphan reply for this campaign (classified or not). Surfaces when
  // the total diverges from pending_notifications so the owner sees there's
  // additional activity beyond the immediately-notifiable set.
  total_orphan_replies: number;
}

export interface AdminUnlinkedCampaignsData {
  rows: UnlinkedCampaignRow[];
  // All clients the user can legitimately target with a link action. The
  // picker in the UI filters per-row by `organization_id`; the PATCH route
  // re-checks server-side.
  clients: Client[];
}

export async function fetchAdminUnlinkedCampaigns(
  supabase: SupabaseClient,
): Promise<AdminUnlinkedCampaignsData> {
  const campaignsRes = await supabase
    .from("campaigns")
    .select("*")
    .is("client_id", null)
    .order("created_at", { ascending: false });
  const campaigns = (campaignsRes.data || []) as Campaign[];

  // One round-trip to aggregate counts for every orphan campaign instead of
  // a count query per row. Orphan-reply volume is low (hundreds at most per
  // orphan) so pulling flag columns client-side is cheaper than N queries.
  const ids = campaigns.map((c) => c.id);
  const stats = new Map<string, { pending: number; total: number }>();
  if (ids.length > 0) {
    const { data: orphanReplies } = await supabase
      .from("lead_replies")
      .select("campaign_id, notification_status, final_class")
      .in("campaign_id", ids)
      .is("client_id", null);
    for (const row of orphanReplies || []) {
      const cid = (row as { campaign_id: string | null }).campaign_id;
      if (!cid) continue;
      const stat = stats.get(cid) ?? { pending: 0, total: 0 };
      stat.total++;
      const r = row as {
        notification_status: string | null;
        final_class: string | null;
      };
      if (r.notification_status === "pending" && r.final_class) stat.pending++;
      stats.set(cid, stat);
    }
  }

  const rows: UnlinkedCampaignRow[] = campaigns.map((c) => ({
    campaign: c,
    pending_notifications: stats.get(c.id)?.pending ?? 0,
    total_orphan_replies: stats.get(c.id)?.total ?? 0,
  }));

  // RLS already scopes clients to the user's org, but scoping by the orphan
  // campaigns' org_ids keeps the picker honest if a multi-org owner ever
  // exists. Empty orphans = empty picker; short-circuit the query.
  const orgIds = Array.from(new Set(campaigns.map((c) => c.organization_id)));
  let clients: Client[] = [];
  if (orgIds.length > 0) {
    const clientsRes = await supabase
      .from("clients")
      .select("*")
      .in("organization_id", orgIds)
      .eq("status", "active")
      .order("name");
    clients = (clientsRes.data || []) as Client[];
  }

  return { rows, clients };
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

// ---------- Pipeline health (D4) ----------
// Read-only "is the reply-chain alive right now?" snapshot. Pulls every card
// from state the earlier SAFETY-TODO commits already populate — no new
// writes, no schema changes. Cards answer:
//   - events flowing in?       webhookEvents.total24h + lastReceivedAt
//   - replies being classified? replies24h (hot / non-hot)
//   - notifications landing?   notifications (pending/sent/failed/retrying/bounced)
//   - anything stuck?          orphanCampaigns + pendingEnrichment
//   - anyone probing?          authFailures24h
export const ADMIN_PIPELINE_HEALTH_KEY = "admin-pipeline-health";

export interface PipelineHealthRecentEvent {
  id: string;
  event_type: string;
  lead_email: string | null;
  received_at: string;
  processed: boolean;
  excluded: boolean;
}

export interface PipelineHealthData {
  webhookEvents: {
    total24h: number;
    byType: Array<{ event_type: string; count: number }>; // top 5
    lastReceivedAt: string | null;
    recent: PipelineHealthRecentEvent[]; // last 50 for the paginated feed
  };
  replies24h: {
    classifiedTotal: number;
    hot: number;
    nonHot: number;
  };
  // notification_status counts across the last 7 days of replies — recent
  // enough to reflect the current pipeline state, long enough to show
  // stuck-but-non-zero buckets. `bounced` is derived from
  // notification_bounced_at (populated by the C3 Resend delivery webhook).
  notifications: {
    pending: number;
    sent: number;
    failed: number;
    retrying: number;
    bounced: number;
  };
  orphanCampaigns: number;
  pendingEnrichment: number;
  authFailures24h: number;
}

export async function fetchAdminPipelineHealth(
  supabase: SupabaseClient,
): Promise<PipelineHealthData> {
  const now = Date.now();
  const twentyFourHoursAgoIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgoIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    webhooksRes,
    lastWebhookRes,
    recentWebhooksRes,
    repliesRes,
    notifStatusRes,
    bouncedRes,
    orphanRes,
    pendingEnrichRes,
    authFailRes,
  ] = await Promise.all([
    supabase
      .from("webhook_events")
      .select("event_type")
      .gte("received_at", twentyFourHoursAgoIso),
    supabase
      .from("webhook_events")
      .select("received_at")
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("webhook_events")
      .select("id, event_type, lead_email, received_at, processed, excluded")
      .order("received_at", { ascending: false })
      .limit(50),
    supabase
      .from("lead_replies")
      .select("final_class")
      .gte("classified_at", twentyFourHoursAgoIso),
    supabase
      .from("lead_replies")
      .select("notification_status")
      .gte("received_at", sevenDaysAgoIso),
    supabase
      .from("lead_replies")
      .select("id", { count: "exact", head: true })
      .not("notification_bounced_at", "is", null)
      .gte("received_at", sevenDaysAgoIso),
    supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .is("client_id", null),
    supabase
      .from("lead_replies")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending_enrichment"),
    supabase
      .from("webhook_auth_failures")
      .select("id", { count: "exact", head: true })
      .gte("created_at", twentyFourHoursAgoIso),
  ]);

  const eventTypeCounts = new Map<string, number>();
  for (const row of webhooksRes.data || []) {
    const t = (row as { event_type: string }).event_type || "unknown";
    eventTypeCounts.set(t, (eventTypeCounts.get(t) || 0) + 1);
  }
  const byType = [...eventTypeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([event_type, count]) => ({ event_type, count }));

  const hotSet = new Set<string>(HOT_REPLY_CLASSES as unknown as string[]);
  let hot = 0;
  let nonHot = 0;
  let classifiedTotal = 0;
  for (const row of repliesRes.data || []) {
    const cls = (row as { final_class: string | null }).final_class;
    if (!cls) continue;
    classifiedTotal++;
    if (hotSet.has(cls)) hot++;
    else nonHot++;
  }

  const notifications = {
    pending: 0,
    sent: 0,
    failed: 0,
    retrying: 0,
    bounced: bouncedRes.count ?? 0,
  };
  for (const row of notifStatusRes.data || []) {
    const s = (row as { notification_status: string }).notification_status;
    if (s === "pending") notifications.pending++;
    else if (s === "sent") notifications.sent++;
    else if (s === "failed") notifications.failed++;
    else if (s === "retrying") notifications.retrying++;
  }

  return {
    webhookEvents: {
      total24h: webhooksRes.data?.length ?? 0,
      byType,
      lastReceivedAt:
        (lastWebhookRes.data as { received_at: string } | null)?.received_at ??
        null,
      recent: (recentWebhooksRes.data ?? []) as PipelineHealthRecentEvent[],
    },
    replies24h: {
      classifiedTotal,
      hot,
      nonHot,
    },
    notifications,
    orphanCampaigns: orphanRes.count ?? 0,
    pendingEnrichment: pendingEnrichRes.count ?? 0,
    authFailures24h: authFailRes.count ?? 0,
  };
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
