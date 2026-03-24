import { createClient } from "@/lib/supabase/server";
import { KPICard } from "@/components/charts/kpi-card";
import { DailyChart } from "@/components/charts/daily-chart";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { ArrowRight, TrendingUp } from "lucide-react";
import type { Campaign, CampaignSnapshot, Client } from "@/types/app";

export default async function ClientDashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Get client record linked to this user
  const { data: clientData } = await supabase
    .from("clients")
    .select("*")
    .eq("user_id", user!.id)
    .single();

  const client = clientData as Client | null;

  if (!client) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="h-12 w-12 rounded-full bg-indigo-50 flex items-center justify-center">
              <TrendingUp size={24} className="text-indigo-400" />
            </div>
          </div>
          <p className="text-muted-foreground font-medium">Your account is being set up.</p>
          <p className="text-sm text-muted-foreground">Please check back soon.</p>
        </div>
      </div>
    );
  }

  // Get campaigns and snapshots
  const [campaignsRes, snapshotsRes] = await Promise.all([
    supabase.from("campaigns").select("*").eq("client_id", client.id),
    supabase
      .from("campaign_snapshots")
      .select("*")
      .in(
        "campaign_id",
        (
          await supabase.from("campaigns").select("id").eq("client_id", client.id)
        ).data?.map((c: { id: string }) => c.id) || ["none"]
      )
      .gte("snapshot_date", new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0])
      .order("snapshot_date", { ascending: false }),
  ]);

  const campaigns = (campaignsRes.data || []) as Campaign[];
  const snapshots = (snapshotsRes.data || []) as CampaignSnapshot[];
  const metrics = calculateMetrics(snapshots);

  return (
    <div className="space-y-6">
      {/* Branded header */}
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Welcome back</p>
          <h1 className="text-2xl font-bold mt-1">{client.name}</h1>
          <p className="text-sm text-white/60 mt-1">
            {campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""} &middot; Last 30 days
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
        <div className="absolute -bottom-6 -right-4 h-24 w-24 rounded-full bg-white/5" />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard label="Emails Sent (30d)" value={metrics.emails_sent} unit="count" />
        <KPICard label="Reply Rate" value={metrics.reply_rate} unit="percent" kpiKey="reply_rate" />
        <KPICard label="Bounce Rate" value={metrics.bounce_rate} unit="percent" kpiKey="bounce_rate" />
        <KPICard label="Meetings Booked" value={metrics.meetings_booked} unit="count" />
      </div>

      {/* Chart */}
      {snapshots.length > 0 && (
        <DailyChart snapshots={snapshots} title="Your Campaign Performance — Last 30 Days" />
      )}

      {/* Campaigns */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <TrendingUp size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Your Campaigns</CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No campaigns yet.</p>
          ) : (
            <div className="space-y-2">
              {campaigns.map((campaign) => {
                const campSnapshots = snapshots.filter(
                  (s) => s.campaign_id === campaign.id
                );
                const campMetrics = calculateMetrics(campSnapshots);

                return (
                  <Link
                    key={campaign.id}
                    href={`/client/campaigns/${campaign.id}`}
                    className="group flex items-center justify-between rounded-xl border border-border/50 p-4 transition-all duration-200 hover:border-indigo-200 hover:shadow-md hover:bg-indigo-50/30"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
                        {campaign.name.charAt(0)}
                      </div>
                      <div>
                        <p className="font-medium text-foreground">{campaign.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {campMetrics.emails_sent} sent &middot; {campMetrics.reply_rate}% reply rate
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge
                        variant="secondary"
                        className={
                          campaign.status === "active"
                            ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                            : "bg-gray-100 text-gray-600 border border-gray-200"
                        }
                      >
                        {campaign.status}
                      </Badge>
                      <ArrowRight size={16} className="text-muted-foreground opacity-0 transition-all group-hover:opacity-100 group-hover:translate-x-0.5" />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
