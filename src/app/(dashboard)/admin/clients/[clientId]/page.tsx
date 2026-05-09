import { createClient } from "@/lib/supabase/server";
import {
  ClientDetailClient,
  type LinkedClientUser,
} from "./client-detail-client";
import type {
  Client,
  Campaign,
  CampaignSnapshot,
  LeadFeedback,
} from "@/types/app";

const SNAPSHOT_COLUMNS =
  "id, campaign_id, snapshot_date, total_leads, emails_sent, replies, " +
  "unique_replies, positive_replies, bounces, unsubscribes, meetings_booked, " +
  "new_leads_contacted, reply_rate, positive_reply_rate, bounce_rate, " +
  "unsubscribe_rate, fetched_at";

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();

  const { data: clientRow } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .maybeSingle();

  if (!clientRow) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Client not found.</p>
      </div>
    );
  }

  const client = clientRow as Client;

  const [campaignsRes, clientUsersRes] = await Promise.all([
    supabase.from("campaigns").select("*").eq("client_id", clientId),
    supabase
      .from("client_users")
      .select("user_id, created_at, invite_status")
      .eq("client_id", clientId),
  ]);

  const campaigns = (campaignsRes.data ?? []) as Campaign[];
  const campaignIds = campaigns.map((c) => c.id);
  const clientUsersData = clientUsersRes.data ?? [];
  const userIds = clientUsersData.map(
    (cu: Record<string, unknown>) => cu.user_id as string,
  );

  // The original page issued a separate `select id from campaigns` here
  // to feed into the feedback IN clause; we already have the IDs from
  // campaignsRes above, so this run is one round-trip cheaper.
  const [snapshotsRes, feedbackRes, profilesRes] = await Promise.all([
    campaignIds.length > 0
      ? supabase
          .from("campaign_snapshots")
          .select(SNAPSHOT_COLUMNS)
          .in("campaign_id", campaignIds)
          .order("snapshot_date", { ascending: false })
      : Promise.resolve({ data: [] }),
    campaignIds.length > 0
      ? supabase
          .from("lead_feedback")
          .select("*")
          .in("campaign_id", campaignIds)
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),
    userIds.length > 0
      ? supabase
          .from("profiles")
          .select("id, email, full_name")
          .in("id", userIds)
      : Promise.resolve({ data: [] }),
  ]);

  const allSnapshots = (snapshotsRes.data ?? []) as unknown as CampaignSnapshot[];
  const feedback = (feedbackRes.data ?? []) as LeadFeedback[];
  const userProfiles = profilesRes.data ?? [];

  const linkedUsers: LinkedClientUser[] = clientUsersData.map(
    (cu: Record<string, unknown>) => {
      const profile = (userProfiles as Record<string, unknown>[]).find(
        (p) => p.id === cu.user_id,
      );
      return {
        user_id: cu.user_id as string,
        email: ((profile?.email as string) || "") as string,
        full_name: (profile?.full_name as string) || null,
        created_at: cu.created_at as string,
        invite_status: ((cu.invite_status as string) || "active") as string,
      };
    },
  );

  return (
    <ClientDetailClient
      clientId={clientId}
      client={client}
      campaigns={campaigns}
      feedback={feedback}
      allSnapshots={allSnapshots}
      linkedUsers={linkedUsers}
    />
  );
}
