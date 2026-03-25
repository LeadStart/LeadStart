"use client";

import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { analyzeStepHealth, getCampaignStepHealth } from "@/lib/kpi/step-health";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { ArrowRight, AlertTriangle, TrendingDown } from "lucide-react";
import type { CampaignSnapshot, Campaign, Client, KPIMetrics, CampaignStepMetric, StepHealthAlert } from "@/types/app";

function HealthDot({ health }: { health: "good" | "warning" | "bad" | "none" }) {
  const colors = { good: "bg-emerald-500", warning: "bg-amber-500", bad: "bg-red-500", none: "bg-gray-300" };
  return <span className={`inline-block h-2 w-2 rounded-full ${colors[health]}`} />;
}

function MiniStat({ label, value, health }: { label: string; value: string; health?: "good" | "warning" | "bad" }) {
  const textColor = health === "good" ? "text-emerald-700" : health === "warning" ? "text-amber-700" : health === "bad" ? "text-red-700" : "text-foreground";
  return (
    <div className="text-center">
      <p className={`text-sm font-bold ${textColor}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
    </div>
  );
}

function getHealthLabel(health: "good" | "warning" | "bad" | "none") {
  return {
    good: { text: "Healthy", class: "bg-emerald-100 text-emerald-700 border-emerald-200" },
    warning: { text: "Step Drop", class: "bg-amber-100 text-amber-700 border-amber-200" },
    bad: { text: "At Risk", class: "bg-red-100 text-red-700 border-red-200" },
    none: { text: "No Data", class: "bg-gray-100 text-gray-500 border-gray-200" },
  }[health];
}

type ClientCard = { client: Client; clientCampaigns: Campaign[]; activeCampaigns: Campaign[]; metrics: KPIMetrics; health: "good" | "warning" | "bad" | "none"; stepAlerts: StepHealthAlert[] };

export default function AdminOverviewPage() {
  const { data, loading } = useSupabaseQuery("admin-overview", async (supabase) => {
    const [clientsRes, campaignsRes, snapshotsRes, stepMetricsRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase.from("campaigns").select("*"),
      supabase.from("campaign_snapshots").select("*")
        .gte("snapshot_date", new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0])
        .order("snapshot_date", { ascending: false }),
      supabase.from("campaign_step_metrics").select("*")
        .order("period_start", { ascending: true }),
    ]);
    const clients = (clientsRes.data || []) as Client[];
    const campaigns = (campaignsRes.data || []) as Campaign[];
    const snapshots = (snapshotsRes.data || []) as CampaignSnapshot[];
    const stepMetrics = (stepMetricsRes.data || []) as CampaignStepMetric[];

    // Build campaign info map for step health analysis
    const campaignInfoMap = new Map<string, { id: string; name: string; client_name: string }>();
    for (const camp of campaigns) {
      const client = clients.find((c) => c.id === camp.client_id);
      campaignInfoMap.set(camp.id, {
        id: camp.id,
        name: camp.name,
        client_name: client?.name || "Unknown",
      });
    }

    // Run step-level health analysis
    const allStepAlerts = analyzeStepHealth(stepMetrics, campaignInfoMap);

    const cards: ClientCard[] = clients.map((client) => {
      const clientCampaigns = campaigns.filter((c) => c.client_id === client.id);
      const activeCampaigns = clientCampaigns.filter((c) => c.status === "active");
      const campaignIds = clientCampaigns.map((c) => c.id);
      const clientSnapshots = snapshots.filter((s) => campaignIds.includes(s.campaign_id));
      const metrics = calculateMetrics(clientSnapshots);

      // Get step alerts for this client's campaigns
      const clientStepAlerts = allStepAlerts.filter((a) => campaignIds.includes(a.campaign_id));

      // Health is based on step-level analysis now
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

      return { client, clientCampaigns, activeCampaigns, metrics, health, stepAlerts: clientStepAlerts };
    });
    const healthOrder = { bad: 0, warning: 1, good: 2, none: 3 };
    cards.sort((a, b) => healthOrder[a.health] - healthOrder[b.health]);
    return { cards, totalActive: campaigns.filter((c) => c.status === "active").length, allStepAlerts };
  });

  const clientCards = data?.cards ?? [];
  const totalActive = data?.totalActive ?? 0;
  const totalClients = clientCards.length;
  const healthyCt = clientCards.filter((c) => c.health === "good").length;
  const warningCt = clientCards.filter((c) => c.health === "warning").length;
  const badCt = clientCards.filter((c) => c.health === "bad").length;

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-36 bg-muted/50" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => <div key={i} className="rounded-xl h-44 bg-muted/50" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Welcome back, Daniel</p>
          <h1 className="text-2xl font-bold mt-1">Client Overview</h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-white/70">
            <span>{totalClients} clients</span>
            <span>{totalActive} active campaigns</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-400" /> {healthyCt} healthy</span>
            {warningCt > 0 && <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" /> {warningCt} warning</span>}
            {badCt > 0 && <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-400" /> {badCt} at risk</span>}
          </div>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
        <div className="absolute -bottom-6 -right-4 h-24 w-24 rounded-full bg-white/5" />
      </div>

      {clientCards.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground font-medium">No clients yet.</p>
            <Link href="/admin/clients" className="text-sm text-indigo-600 font-medium hover:underline mt-1 inline-block">Add your first client</Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {clientCards.map(({ client, activeCampaigns, clientCampaigns, metrics, health, stepAlerts }) => {
            const healthLabel = getHealthLabel(health);
            return (
              <Link key={client.id} href={`/admin/clients/${client.id}`} className="group block">
                <Card className="border-border/50 shadow-sm transition-all duration-200 hover:border-indigo-200 hover:shadow-md h-full">
                  <CardContent className="pt-5 pb-4 px-5">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>{client.name.charAt(0)}</div>
                        <div>
                          <p className="font-semibold text-foreground">{client.name}</p>
                          <p className="text-xs text-muted-foreground">{activeCampaigns.length} active / {clientCampaigns.length} total</p>
                        </div>
                      </div>
                      <ArrowRight size={16} className="text-muted-foreground mt-1 opacity-0 transition-all group-hover:opacity-100 group-hover:translate-x-0.5" />
                    </div>
                    <div className="mb-3 space-y-1.5">
                      <Badge variant="secondary" className={`text-xs border ${healthLabel.class}`}><HealthDot health={health} /><span className="ml-1.5">{healthLabel.text}</span></Badge>
                      {/* Step-level alerts */}
                      {stepAlerts.length > 0 && (
                        <div className="space-y-1">
                          {stepAlerts.slice(0, 2).map((alert, i) => (
                            <div key={i} className={`flex items-center gap-1.5 text-[10px] rounded-md px-2 py-1 ${
                              alert.severity === "critical"
                                ? "bg-red-50 text-red-700"
                                : "bg-amber-50 text-amber-700"
                            }`}>
                              {alert.severity === "critical" ? <AlertTriangle size={10} /> : <TrendingDown size={10} />}
                              <span className="font-medium">Step {alert.step}</span>
                              <span>{alert.metric === "reply_rate" ? "reply" : "bounce"} {alert.change_pct > 0 ? "+" : ""}{alert.change_pct}%</span>
                              <span className="text-[9px] opacity-70">({alert.current_value}% vs {alert.baseline_value}% avg)</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {metrics.emails_sent > 0 ? (
                      <div className="grid grid-cols-4 gap-2 pt-3 border-t border-border/50">
                        <MiniStat label="Sent" value={metrics.emails_sent.toLocaleString()} />
                        <MiniStat label="Reply" value={`${metrics.reply_rate}%`} health={metrics.reply_rate >= 5 ? "good" : metrics.reply_rate >= 2 ? "warning" : "bad"} />
                        <MiniStat label="Bounce" value={`${metrics.bounce_rate}%`} health={metrics.bounce_rate <= 2 ? "good" : metrics.bounce_rate <= 5 ? "warning" : "bad"} />
                        <MiniStat label="Positive" value={String(metrics.meetings_booked)} />
                      </div>
                    ) : (
                      <div className="pt-3 border-t border-border/50"><p className="text-xs text-muted-foreground text-center py-2">No campaign data yet</p></div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
