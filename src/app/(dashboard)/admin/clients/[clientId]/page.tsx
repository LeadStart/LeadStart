import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { KPICard } from "@/components/charts/kpi-card";
import { DailyChart } from "@/components/charts/daily-chart";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InviteClientButton } from "./invite-client-button";
import { ArrowLeft, ArrowRight, Mail, MessageSquare } from "lucide-react";
import type { Client, Campaign, CampaignSnapshot, LeadFeedback } from "@/types/app";

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .single();

  if (!client) notFound();

  const typedClient = client as Client;

  const [campaignsRes, feedbackRes] = await Promise.all([
    supabase.from("campaigns").select("*").eq("client_id", clientId),
    supabase
      .from("lead_feedback")
      .select("*")
      .in(
        "campaign_id",
        (
          await supabase.from("campaigns").select("id").eq("client_id", clientId)
        ).data?.map((c) => (c as Record<string, unknown>).id as string) || []
      )
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const campaigns = (campaignsRes.data || []) as Campaign[];
  const feedback = (feedbackRes.data || []) as LeadFeedback[];

  // Get snapshots for all client campaigns
  const campaignIds = campaigns.map((c) => c.id);
  const { data: snapshotsData } = await supabase
    .from("campaign_snapshots")
    .select("*")
    .in("campaign_id", campaignIds.length > 0 ? campaignIds : ["none"])
    .gte("snapshot_date", new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0])
    .order("snapshot_date", { ascending: false });

  const snapshots = (snapshotsData || []) as CampaignSnapshot[];
  const metrics = calculateMetrics(snapshots);

  return (
    <div className="space-y-6">
      {/* Navigation + Header */}
      <div>
        <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft size={14} />
          Back to Overview
        </Link>
        <div className="relative overflow-hidden rounded-xl p-6 text-white mt-3" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
          <div className="relative z-10 flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">{typedClient.name}</h1>
              <p className="text-sm text-white/60 mt-1">
                {typedClient.contact_email || "No email"} &middot; {campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}
              </p>
            </div>
            <div className="flex gap-2">
              {!typedClient.user_id && typedClient.contact_email && (
                <InviteClientButton
                  clientId={typedClient.id}
                  clientEmail={typedClient.contact_email}
                />
              )}
              {typedClient.user_id && (
                <Badge className="bg-white/15 text-white border-0">Portal Active</Badge>
              )}
            </div>
          </div>
          <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
        </div>
      </div>

      {/* Aggregate KPIs for this client */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard label="Emails Sent (30d)" value={metrics.emails_sent} unit="count" />
        <KPICard label="Reply Rate" value={metrics.reply_rate} unit="percent" kpiKey="reply_rate" />
        <KPICard label="Bounce Rate" value={metrics.bounce_rate} unit="percent" kpiKey="bounce_rate" />
        <KPICard label="Positive Responses" value={metrics.meetings_booked} unit="count" kpiKey="meetings_booked" />
      </div>

      {/* Chart */}
      {snapshots.length > 0 && (
        <DailyChart snapshots={snapshots} title={`${typedClient.name} — Last 30 Days`} />
      )}

      {/* Per-Campaign Breakdown */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <Mail size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Campaigns ({campaigns.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No campaigns mapped yet.</p>
          ) : (
            <div className="space-y-3">
              {campaigns.map((campaign) => {
                const campSnapshots = snapshots.filter((s) => s.campaign_id === campaign.id);
                const campMetrics = calculateMetrics(campSnapshots);

                return (
                  <Link
                    key={campaign.id}
                    href={`/admin/clients/${clientId}/campaigns/${campaign.id}`}
                    className="group block rounded-xl border border-border/50 p-4 transition-all hover:border-indigo-200 hover:shadow-md"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
                          <Mail size={14} />
                        </div>
                        <div>
                          <p className="font-medium text-foreground">{campaign.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">
                            {campaign.instantly_campaign_id}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="secondary"
                          className={
                            campaign.status === "active"
                              ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                              : campaign.status === "paused"
                              ? "bg-amber-100 text-amber-800 border border-amber-200"
                              : "bg-gray-100 text-gray-600 border border-gray-200"
                          }
                        >
                          {campaign.status}
                        </Badge>
                        <ArrowRight size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>

                    {/* Campaign-level mini metrics */}
                    {campMetrics.emails_sent > 0 ? (
                      <div className="grid grid-cols-4 gap-4 pt-3 border-t border-border/30">
                        <div>
                          <p className="text-sm font-bold">{campMetrics.emails_sent.toLocaleString()}</p>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Sent</p>
                        </div>
                        <div>
                          <p className={`text-sm font-bold ${campMetrics.reply_rate >= 5 ? "text-emerald-700" : campMetrics.reply_rate >= 2 ? "text-amber-700" : "text-red-700"}`}>
                            {campMetrics.reply_rate}%
                          </p>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Reply</p>
                        </div>
                        <div>
                          <p className={`text-sm font-bold ${campMetrics.bounce_rate <= 2 ? "text-emerald-700" : campMetrics.bounce_rate <= 5 ? "text-amber-700" : "text-red-700"}`}>
                            {campMetrics.bounce_rate}%
                          </p>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Bounce</p>
                        </div>
                        <div>
                          <p className="text-sm font-bold">{campMetrics.meetings_booked}</p>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Positive</p>
                        </div>
                      </div>
                    ) : (
                      <div className="pt-3 border-t border-border/30">
                        <p className="text-xs text-muted-foreground">No data yet</p>
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Feedback */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <MessageSquare size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Recent Feedback</CardTitle>
        </CardHeader>
        <CardContent>
          {feedback.length === 0 ? (
            <p className="text-sm text-muted-foreground">No feedback yet.</p>
          ) : (
            <div className="space-y-2">
              {feedback.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-3 rounded-xl border border-border/50 p-3 text-sm transition-colors hover:bg-muted/30"
                >
                  <Badge
                    variant="secondary"
                    className={
                      ["good_lead", "interested"].includes(f.status)
                        ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                        : ["bad_lead", "wrong_person", "not_interested"].includes(f.status)
                        ? "bg-red-100 text-red-800 border border-red-200"
                        : "bg-gray-100 text-gray-600 border border-gray-200"
                    }
                  >
                    {f.status.replace(/_/g, " ")}
                  </Badge>
                  <span className="font-medium">{f.lead_email}</span>
                  {f.comment && (
                    <span className="text-muted-foreground truncate">{f.comment}</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(f.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
