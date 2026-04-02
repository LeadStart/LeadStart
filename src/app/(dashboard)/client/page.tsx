"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { KPICard } from "@/components/charts/kpi-card";
import { MonthlyPositiveChart } from "@/components/charts/monthly-positive-chart";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowRight, TrendingUp, FileText, Mail } from "lucide-react";
import type { Campaign, CampaignSnapshot, Client, KPIReport } from "@/types/app";

function getDateRange(preset: string): { start: string; end: string } {
  const today = new Date();
  const end = today.toISOString().split("T")[0];
  let start: Date;
  switch (preset) {
    case "7d":
      start = new Date(today); start.setDate(start.getDate() - 7); break;
    case "30d":
      start = new Date(today); start.setDate(start.getDate() - 30); break;
    case "90d":
      start = new Date(today); start.setDate(start.getDate() - 90); break;
    case "mtd":
      start = new Date(today.getFullYear(), today.getMonth(), 1); break;
    case "last_month":
      start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      return { start: start.toISOString().split("T")[0], end: new Date(today.getFullYear(), today.getMonth(), 0).toISOString().split("T")[0] };
    default:
      start = new Date(today); start.setDate(start.getDate() - 30);
  }
  return { start: start.toISOString().split("T")[0], end };
}

export default function ClientDashboardPage() {
  const [client, setClient] = useState<Client | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [snapshots, setSnapshots] = useState<CampaignSnapshot[]>([]);
  const [allTimeSnapshots, setAllTimeSnapshots] = useState<CampaignSnapshot[]>([]);
  const [reports, setReports] = useState<KPIReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [noClient, setNoClient] = useState(false);
  const [datePreset, setDatePreset] = useState("30d");
  const [startDate, setStartDate] = useState(() => getDateRange("30d").start);
  const [endDate, setEndDate] = useState(() => getDateRange("30d").end);
  const [campaignIds, setCampaignIds] = useState<string[]>([]);

  // Initial load — get client and campaigns
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data: clientData } = await supabase.from("clients").select("*").eq("user_id", user.id).single();
      if (!clientData) { setNoClient(true); setLoading(false); return; }
      const c = clientData as Client;
      setClient(c);
      const [campsRes, reportsRes] = await Promise.all([
        supabase.from("campaigns").select("*").eq("client_id", c.id),
        supabase.from("kpi_reports").select("*").eq("client_id", c.id).order("created_at", { ascending: false }).limit(5),
      ]);
      const camps = (campsRes.data || []) as Campaign[];
      setCampaigns(camps);
      setCampaignIds(camps.map(x => x.id));
      setReports((reportsRes.data || []) as KPIReport[]);
    });
  }, []);

  // Fetch snapshots when date range or campaigns change
  const fetchSnapshots = useCallback(async () => {
    if (campaignIds.length === 0) { setLoading(false); return; }
    setLoading(true);
    const supabase = createClient();
    const [filtered, allTime] = await Promise.all([
      supabase
        .from("campaign_snapshots").select("*")
        .in("campaign_id", campaignIds)
        .gte("snapshot_date", startDate)
        .lte("snapshot_date", endDate)
        .order("snapshot_date", { ascending: false }),
      supabase
        .from("campaign_snapshots").select("*")
        .in("campaign_id", campaignIds)
        .order("snapshot_date", { ascending: true }),
    ]);
    setSnapshots((filtered.data || []) as CampaignSnapshot[]);
    setAllTimeSnapshots((allTime.data || []) as CampaignSnapshot[]);
    setLoading(false);
  }, [campaignIds, startDate, endDate]);

  useEffect(() => { fetchSnapshots(); }, [fetchSnapshots]);

  function handlePresetChange(val: string) {
    setDatePreset(val);
    const range = getDateRange(val);
    setStartDate(range.start);
    setEndDate(range.end);
  }

  if (loading && !client) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-36 bg-muted/50" />
        <div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <div key={i} className="rounded-xl h-28 bg-muted/50" />)}</div>
        <div className="rounded-xl h-64 bg-muted/50" />
      </div>
    );
  }

  if (noClient || !client) {
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

  const metrics = calculateMetrics(snapshots);
  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Welcome back</p>
          <h1 className="text-2xl font-bold mt-1">{client.name}</h1>
          <p className="text-sm text-white/60 mt-1">{campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
        <div className="absolute -bottom-6 -right-4 h-24 w-24 rounded-full bg-white/5" />
      </div>

      {/* Row 1: KPIs + Date Range */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="Emails Sent" value={metrics.emails_sent} unit="count" />
        <KPICard label="Positive Responses" value={metrics.meetings_booked} unit="count" />
        <Card className="border-border/50 shadow-sm col-span-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-end gap-3 flex-wrap">
              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Range</Label>
                <Select value={datePreset} onValueChange={handlePresetChange}>
                  <SelectTrigger className="w-[120px]" style={{ height: '32px' }}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7d">Last 7 Days</SelectItem>
                    <SelectItem value="30d">Last 30 Days</SelectItem>
                    <SelectItem value="90d">Last 90 Days</SelectItem>
                    <SelectItem value="mtd">Month to Date</SelectItem>
                    <SelectItem value="last_month">Last Month</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">From</Label>
                <Input style={{ height: '32px' }} className="w-[120px] text-xs" type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setDatePreset(""); }} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">To</Label>
                <Input style={{ height: '32px' }} className="w-[120px] text-xs" type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setDatePreset(""); }} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Monthly chart (left) + Campaigns (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {allTimeSnapshots.length > 0 && <MonthlyPositiveChart snapshots={allTimeSnapshots} height={200} />}

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
                  const campSnapshots = snapshots.filter((s) => s.campaign_id === campaign.id);
                  const campMetrics = calculateMetrics(campSnapshots);
                  return (
                    <Link key={campaign.id} href={`/client/campaigns/${campaign.id}`} className="group flex items-center justify-between rounded-xl border border-border/50 p-3 transition-all duration-200 hover:border-indigo-200 hover:shadow-md hover:bg-indigo-50/30">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
                          {campaign.name.charAt(0)}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-sm text-foreground truncate">{campaign.name}</p>
                          <p className="text-xs text-muted-foreground">{campMetrics.emails_sent.toLocaleString()} sent · {campMetrics.meetings_booked} positive</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="secondary" className={`text-[10px] ${campaign.status === "active" ? "bg-emerald-100 text-emerald-800 border border-emerald-200" : "bg-gray-100 text-gray-600 border border-gray-200"}`}>
                          {campaign.status}
                        </Badge>
                        <ArrowRight size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100" />
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Report History */}
      {reports.length > 0 && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center gap-2 pb-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
              <FileText size={16} className="text-indigo-500" />
            </div>
            <CardTitle className="text-base">Report History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {reports.map((report) => {
                const { totals, period } = report.report_data;
                const wasSent = !!report.sent_at;
                return (
                  <div key={report.id} className="rounded-lg border border-border/50 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold">
                        {new Date(period.start).toLocaleDateString("en-US", { month: "short", day: "numeric" })} — {new Date(period.end).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </span>
                      {wasSent ? <Badge className="bg-emerald-100 text-emerald-700 border border-emerald-200 text-[10px]"><Mail size={10} className="mr-1" />Delivered</Badge> : <Badge className="bg-amber-100 text-amber-700 border border-amber-200 text-[10px]">Draft</Badge>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="text-center p-1.5 rounded bg-indigo-50/50"><p className="text-sm font-bold text-indigo-700">{totals.emails_sent.toLocaleString()}</p><p className="text-[10px] text-muted-foreground">Sent</p></div>
                      <div className="text-center p-1.5 rounded bg-emerald-50/50"><p className="text-sm font-bold text-emerald-700">{totals.meetings_booked}</p><p className="text-[10px] text-muted-foreground">Positive</p></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
