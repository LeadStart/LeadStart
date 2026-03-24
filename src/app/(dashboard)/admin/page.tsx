import { createClient } from "@/lib/supabase/server";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import {
  ArrowRight,
  Mail,
  MessageSquare,
  CalendarCheck,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
} from "lucide-react";
import type { CampaignSnapshot, Campaign, Client } from "@/types/app";

function HealthDot({ health }: { health: "good" | "warning" | "bad" | "none" }) {
  const colors = {
    good: "bg-emerald-500",
    warning: "bg-amber-500",
    bad: "bg-red-500",
    none: "bg-gray-300",
  };
  return <span className={`inline-block h-2 w-2 rounded-full ${colors[health]}`} />;
}

function MiniStat({
  label,
  value,
  health,
}: {
  label: string;
  value: string;
  health?: "good" | "warning" | "bad";
}) {
  const textColor = health === "good"
    ? "text-emerald-700"
    : health === "warning"
    ? "text-amber-700"
    : health === "bad"
    ? "text-red-700"
    : "text-foreground";

  return (
    <div className="text-center">
      <p className={`text-sm font-bold ${textColor}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
    </div>
  );
}

function getOverallHealth(replyRate: number, bounceRate: number, emailsSent: number): "good" | "warning" | "bad" | "none" {
  if (emailsSent === 0) return "none";
  if (bounceRate > 5 || replyRate < 2) return "bad";
  if (bounceRate > 3 || replyRate < 5) return "warning";
  return "good";
}

function getHealthLabel(health: "good" | "warning" | "bad" | "none") {
  return {
    good: { text: "Healthy", class: "bg-emerald-100 text-emerald-700 border-emerald-200" },
    warning: { text: "Needs Attention", class: "bg-amber-100 text-amber-700 border-amber-200" },
    bad: { text: "At Risk", class: "bg-red-100 text-red-700 border-red-200" },
    none: { text: "No Data", class: "bg-gray-100 text-gray-500 border-gray-200" },
  }[health];
}

export default async function AdminOverviewPage() {
  const supabase = await createClient();

  const [clientsRes, campaignsRes, snapshotsRes] = await Promise.all([
    supabase.from("clients").select("*").order("name"),
    supabase.from("campaigns").select("*"),
    supabase
      .from("campaign_snapshots")
      .select("*")
      .gte("snapshot_date", new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0])
      .order("snapshot_date", { ascending: false }),
  ]);

  const clients = (clientsRes.data || []) as Client[];
  const campaigns = (campaignsRes.data || []) as Campaign[];
  const snapshots = (snapshotsRes.data || []) as CampaignSnapshot[];

  // Build per-client data
  const clientCards = clients.map((client) => {
    const clientCampaigns = campaigns.filter((c) => c.client_id === client.id);
    const activeCampaigns = clientCampaigns.filter((c) => c.status === "active");
    const campaignIds = clientCampaigns.map((c) => c.id);
    const clientSnapshots = snapshots.filter((s) => campaignIds.includes(s.campaign_id));
    const metrics = calculateMetrics(clientSnapshots);
    const health = getOverallHealth(metrics.reply_rate, metrics.bounce_rate, metrics.emails_sent);

    return { client, clientCampaigns, activeCampaigns, metrics, health };
  });

  // Sort: bad first, then warning, then good, then none
  const healthOrder = { bad: 0, warning: 1, good: 2, none: 3 };
  clientCards.sort((a, b) => healthOrder[a.health] - healthOrder[b.health]);

  // Quick totals for the header
  const totalClients = clients.length;
  const totalActive = campaigns.filter((c) => c.status === "active").length;
  const healthyCt = clientCards.filter((c) => c.health === "good").length;
  const warningCt = clientCards.filter((c) => c.health === "warning").length;
  const badCt = clientCards.filter((c) => c.health === "bad").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Welcome back, Daniel</p>
          <h1 className="text-2xl font-bold mt-1">Client Overview</h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-white/70">
            <span>{totalClients} clients</span>
            <span>{totalActive} active campaigns</span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-400" /> {healthyCt} healthy
            </span>
            {warningCt > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-amber-400" /> {warningCt} warning
              </span>
            )}
            {badCt > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-red-400" /> {badCt} at risk
              </span>
            )}
          </div>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
        <div className="absolute -bottom-6 -right-4 h-24 w-24 rounded-full bg-white/5" />
      </div>

      {/* Client Cards Grid */}
      {clientCards.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground font-medium">No clients yet.</p>
            <Link href="/admin/clients" className="text-sm text-indigo-600 font-medium hover:underline mt-1 inline-block">
              Add your first client
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {clientCards.map(({ client, activeCampaigns, clientCampaigns, metrics, health }) => {
            const healthLabel = getHealthLabel(health);

            return (
              <Link
                key={client.id}
                href={`/admin/clients/${client.id}`}
                className="group block"
              >
                <Card className="border-border/50 shadow-sm transition-all duration-200 hover:border-indigo-200 hover:shadow-md h-full">
                  <CardContent className="pt-5 pb-4 px-5">
                    {/* Client header */}
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
                          {client.name.charAt(0)}
                        </div>
                        <div>
                          <p className="font-semibold text-foreground">{client.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {activeCampaigns.length} active / {clientCampaigns.length} total
                          </p>
                        </div>
                      </div>
                      <ArrowRight size={16} className="text-muted-foreground mt-1 opacity-0 transition-all group-hover:opacity-100 group-hover:translate-x-0.5" />
                    </div>

                    {/* Health badge */}
                    <div className="mb-4">
                      <Badge variant="secondary" className={`text-xs border ${healthLabel.class}`}>
                        <HealthDot health={health} />
                        <span className="ml-1.5">{healthLabel.text}</span>
                      </Badge>
                    </div>

                    {/* Mini metrics row */}
                    {metrics.emails_sent > 0 ? (
                      <div className="grid grid-cols-4 gap-2 pt-3 border-t border-border/50">
                        <MiniStat
                          label="Sent"
                          value={metrics.emails_sent.toLocaleString()}
                        />
                        <MiniStat
                          label="Reply"
                          value={`${metrics.reply_rate}%`}
                          health={metrics.reply_rate >= 5 ? "good" : metrics.reply_rate >= 2 ? "warning" : "bad"}
                        />
                        <MiniStat
                          label="Bounce"
                          value={`${metrics.bounce_rate}%`}
                          health={metrics.bounce_rate <= 2 ? "good" : metrics.bounce_rate <= 5 ? "warning" : "bad"}
                        />
                        <MiniStat
                          label="Meetings"
                          value={String(metrics.meetings_booked)}
                        />
                      </div>
                    ) : (
                      <div className="pt-3 border-t border-border/50">
                        <p className="text-xs text-muted-foreground text-center py-2">
                          No campaign data yet
                        </p>
                      </div>
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
