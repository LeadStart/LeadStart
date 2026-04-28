"use client";

import { use, useState, useMemo } from "react";
import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { KPICard } from "@/components/charts/kpi-card";
import { DailyChart } from "@/components/charts/daily-chart";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, TrendingUp } from "lucide-react";
import { LinkedinClientCampaign } from "./linkedin-client-campaign";
import type { Campaign, CampaignSnapshot } from "@/types/app";

const supabase = createClient();

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

async function fetchClientCampaign(campaignId: string) {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();

  if (!campaign) return null;

  const { data: snapshotsData } = await supabase
    .from("campaign_snapshots")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("snapshot_date", { ascending: false });

  return {
    campaign: campaign as Campaign,
    snapshots: (snapshotsData || []) as CampaignSnapshot[],
  };
}

export default function ClientCampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = use(params);
  const { data } = useSWR(`client-campaign-${campaignId}`, () => fetchClientCampaign(campaignId));
  const [datePreset, setDatePreset] = useState("30d");
  const [startDate, setStartDate] = useState(() => getDateRange("30d").start);
  const [endDate, setEndDate] = useState(() => getDateRange("30d").end);

  function handlePresetChange(val: string | null) {
    if (!val) return;
    setDatePreset(val);
    if (val !== "custom") {
      const range = getDateRange(val);
      setStartDate(range.start);
      setEndDate(range.end);
    }
  }

  // Filter snapshots by selected date range
  const filteredSnapshots = useMemo(() => {
    if (!data?.snapshots) return [];
    return data.snapshots.filter((s) => s.snapshot_date >= startDate && s.snapshot_date <= endDate);
  }, [data?.snapshots, startDate, endDate]);

  // LinkedIn campaigns get a stripped-down view (no email-shaped chart /
  // bounce-rate KPI). Branched here AFTER all hooks have run so the
  // rules-of-hooks order is preserved across renders.
  if (data?.campaign?.source_channel === "linkedin") {
    return <LinkedinClientCampaign params={params} />;
  }

  if (!data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-32 rounded bg-muted" />
        <div className="h-32 rounded-xl bg-muted" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-muted" />
          ))}
        </div>
        <div className="h-64 rounded-xl bg-muted" />
      </div>
    );
  }

  if (!data.campaign) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Campaign not found.</p>
      </div>
    );
  }

  const { campaign: typedCampaign } = data;
  const metrics = calculateMetrics(filteredSnapshots);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link href="/client" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft size={14} />
          Back to Dashboard
        </Link>
        <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a] mt-3" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
          <div className="relative z-10">
            <Badge className="bg-white/15 text-[#0f172a] border-0 mb-2">
              {typedCampaign.status}
            </Badge>
            <h1 className="text-2xl font-bold">{typedCampaign.name}</h1>
          </div>
          <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
        </div>
      </div>

      {/* Campaign Performance with date picker */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]"><TrendingUp size={16} className="text-white" /></div>
          <h2 className="text-[15px] font-semibold text-[#0f172a]">Campaign Performance</h2>
        </div>
        <div className="flex items-center gap-3">
          {datePreset !== "custom" && (
            <span className="text-xs text-muted-foreground">
              {new Date(startDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })} — {new Date(endDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </span>
          )}
          <Select value={datePreset} onValueChange={handlePresetChange}>
            <SelectTrigger className="h-8 w-[130px] border-border/50 text-xs font-medium"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 Days</SelectItem>
              <SelectItem value="30d">Last 30 Days</SelectItem>
              <SelectItem value="90d">Last 90 Days</SelectItem>
              <SelectItem value="mtd">Month to Date</SelectItem>
              <SelectItem value="last_month">Last Month</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {datePreset === "custom" && (
        <Card className="border-border/50 shadow-sm overflow-hidden mb-4">
          <div className="flex items-end gap-4 px-6 py-3 bg-[#2E37FE]/5">
            <div className="space-y-1 flex-1 min-w-0">
              <Label className="text-xs font-medium text-[#2E37FE]/70">From</Label>
              <Input className="h-9 w-full text-sm" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1 flex-1 min-w-0">
              <Label className="text-xs font-medium text-[#2E37FE]/70">To</Label>
              <Input className="h-9 w-full text-sm" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
        </Card>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <KPICard label="Emails Sent" value={metrics.emails_sent} unit="count" />
        <KPICard label="Positive Responses" value={metrics.meetings_booked} unit="count" />
      </div>

      {/* Chart */}
      {filteredSnapshots.length > 0 && <DailyChart snapshots={filteredSnapshots} />}
    </div>
  );
}
