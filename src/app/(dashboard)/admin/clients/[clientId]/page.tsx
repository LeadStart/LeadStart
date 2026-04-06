"use client";

import { use, useState } from "react";
import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { KPICard } from "@/components/charts/kpi-card";
import { DailyChart } from "@/components/charts/daily-chart";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClientActions } from "./client-actions";
import { ArrowLeft, ArrowRight, Mail, MessageSquare, Calendar } from "lucide-react";
import type { Client, Campaign, CampaignSnapshot, LeadFeedback } from "@/types/app";

const supabase = createClient();

async function fetchClientDetail(clientId: string) {
  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .single();

  if (!client) return null;

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
  const campaignIds = campaigns.map((c) => c.id);

  // Fetch ALL snapshots (lifetime) — no date filter
  const { data: allSnapshotsData } = await supabase
    .from("campaign_snapshots")
    .select("*")
    .in("campaign_id", campaignIds.length > 0 ? campaignIds : ["none"])
    .order("snapshot_date", { ascending: false });

  return {
    client: client as Client,
    campaigns,
    feedback,
    allSnapshots: (allSnapshotsData || []) as CampaignSnapshot[],
  };
}

type Period = "7d" | "30d" | "lifetime";

function filterByPeriod(snapshots: CampaignSnapshot[], period: Period): CampaignSnapshot[] {
  if (period === "lifetime") return snapshots;
  const days = period === "7d" ? 7 : 30;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
  return snapshots.filter((s) => s.snapshot_date >= cutoff);
}

export default function ClientDetailPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = use(params);
  const { data } = useSWR(`client-detail-${clientId}`, () => fetchClientDetail(clientId));
  const [period, setPeriod] = useState<Period>("30d");

  if (!data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-32 rounded bg-muted" />
        <div className="h-32 rounded-xl bg-muted" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <div key={i} className="h-24 rounded-xl bg-muted" />)}
        </div>
        <div className="h-64 rounded-xl bg-muted" />
      </div>
    );
  }

  if (!data.client) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Client not found.</p>
      </div>
    );
  }

  const { client: typedClient, campaigns, feedback, allSnapshots } = data;
  const periodSnapshots = filterByPeriod(allSnapshots, period);
  const periodMetrics = calculateMetrics(periodSnapshots);
  const lifetimeMetrics = calculateMetrics(allSnapshots);

  const periodLabel = period === "7d" ? "Last 7 Days" : period === "30d" ? "Last 30 Days" : "Lifetime";

  return (
    <div className="space-y-6">
      {/* Navigation + Header */}
      <div>
        <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft size={14} />
          Back to Overview
        </Link>
        <div className="relative overflow-hidden rounded-xl p-6 text-white mt-3" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
          <div className="relative z-10">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-bold">{typedClient.name}</h1>
                <p className="text-xs text-white/50 mt-0.5">
                  {campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>
            <div className="mt-3">
              <ClientActions client={typedClient} onEmailUpdated={(email) => {
                typedClient.contact_email = email;
              }} />
            </div>
          </div>
          <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
        </div>
      </div>

      {/* Period Selector */}
      <div className="flex items-center gap-2">
        <Calendar size={14} className="text-muted-foreground" />
        {(["7d", "30d", "lifetime"] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              period === p
                ? "bg-indigo-100 text-indigo-700 border border-indigo-200"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
          >
            {p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : "Lifetime"}
          </button>
        ))}
      </div>

      {/* Aggregate KPIs — period metrics with lifetime comparison */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label={`Emails Sent (${periodLabel})`}
          value={periodMetrics.emails_sent}
          unit="count"
          subtitle={period !== "lifetime" ? `${lifetimeMetrics.emails_sent.toLocaleString()} lifetime` : undefined}
        />
        <KPICard
          label="Reply Rate"
          value={periodMetrics.reply_rate}
          unit="percent"
          kpiKey="reply_rate"
          subtitle={period !== "lifetime" ? `${lifetimeMetrics.reply_rate}% lifetime` : undefined}
        />
        <KPICard
          label="Bounce Rate"
          value={periodMetrics.bounce_rate}
          unit="percent"
          kpiKey="bounce_rate"
          subtitle={period !== "lifetime" ? `${lifetimeMetrics.bounce_rate}% lifetime` : undefined}
        />
        <KPICard
          label="Positive Responses"
          value={periodMetrics.meetings_booked}
          unit="count"
          kpiKey="meetings_booked"
          subtitle={period !== "lifetime" ? `${lifetimeMetrics.meetings_booked} lifetime` : undefined}
        />
      </div>

      {/* Chart */}
      {periodSnapshots.length > 0 && (
        <DailyChart snapshots={periodSnapshots} title={`${typedClient.name} — ${periodLabel}`} />
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
                const campAllSnapshots = allSnapshots.filter((s) => s.campaign_id === campaign.id);
                const campPeriodSnapshots = filterByPeriod(campAllSnapshots, period);
                const campPeriodMetrics = calculateMetrics(campPeriodSnapshots);
                const campLifetimeMetrics = calculateMetrics(campAllSnapshots);

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

                    {/* Campaign metrics — period row */}
                    {campPeriodMetrics.emails_sent > 0 || campLifetimeMetrics.emails_sent > 0 ? (
                      <div className="space-y-2 pt-3 border-t border-border/30">
                        {/* Period metrics */}
                        <div className="grid grid-cols-4 gap-4">
                          <div>
                            <p className="text-sm font-bold">{campPeriodMetrics.emails_sent.toLocaleString()}</p>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Sent</p>
                          </div>
                          <div>
                            <p className={`text-sm font-bold ${campPeriodMetrics.reply_rate >= 5 ? "text-emerald-700" : campPeriodMetrics.reply_rate >= 2 ? "text-amber-700" : "text-red-700"}`}>
                              {campPeriodMetrics.reply_rate}%
                            </p>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Reply</p>
                          </div>
                          <div>
                            <p className={`text-sm font-bold ${campPeriodMetrics.bounce_rate <= 2 ? "text-emerald-700" : campPeriodMetrics.bounce_rate <= 5 ? "text-amber-700" : "text-red-700"}`}>
                              {campPeriodMetrics.bounce_rate}%
                            </p>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Bounce</p>
                          </div>
                          <div>
                            <p className="text-sm font-bold">{campPeriodMetrics.meetings_booked}</p>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Positive</p>
                          </div>
                        </div>
                        {/* Lifetime row (if not already viewing lifetime) */}
                        {period !== "lifetime" && campLifetimeMetrics.emails_sent > 0 && (
                          <div className="grid grid-cols-4 gap-4 text-muted-foreground">
                            <div>
                              <p className="text-xs">{campLifetimeMetrics.emails_sent.toLocaleString()}</p>
                              <p className="text-[9px] uppercase tracking-wide">Lifetime</p>
                            </div>
                            <div>
                              <p className="text-xs">{campLifetimeMetrics.reply_rate}%</p>
                              <p className="text-[9px] uppercase tracking-wide">Lifetime</p>
                            </div>
                            <div>
                              <p className="text-xs">{campLifetimeMetrics.bounce_rate}%</p>
                              <p className="text-[9px] uppercase tracking-wide">Lifetime</p>
                            </div>
                            <div>
                              <p className="text-xs">{campLifetimeMetrics.meetings_booked}</p>
                              <p className="text-[9px] uppercase tracking-wide">Lifetime</p>
                            </div>
                          </div>
                        )}
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
