"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CampaignSnapshot } from "@/types/app";

type SeriesKey = "Sent" | "Replies" | "Bounces" | "Positive";

const SERIES_CONFIG: Record<SeriesKey, { color: string; label: string }> = {
  Sent: { color: "#6B72FF", label: "Sent" },
  Replies: { color: "#10b981", label: "Replies" },
  Bounces: { color: "#ef4444", label: "Bounces" },
  Positive: { color: "#f59e0b", label: "Positive Responses" },
};

interface DailyChartProps {
  snapshots: CampaignSnapshot[];
  title?: string;
  series?: SeriesKey[];
  height?: number;
}

export function DailyChart({
  snapshots,
  title = "Daily Performance",
  series = ["Sent", "Replies", "Bounces", "Positive"],
  height = 300,
}: DailyChartProps) {
  const data = snapshots
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
    .map((s) => ({
      date: new Date(s.snapshot_date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      Sent: s.emails_sent,
      Replies: s.replies,
      Bounces: s.bounces,
      Positive: s.meetings_booked,
    }));

  const activeSeries = series.filter((s) => SERIES_CONFIG[s]);

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            {activeSeries.map((key) => (
              <span key={key} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES_CONFIG[key].color }} />
                {SERIES_CONFIG[key].label}
              </span>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="gradSent" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6B72FF" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#6B72FF" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradReplies" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="date" fontSize={11} tick={{ fill: "#64748b" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
            <YAxis fontSize={11} tick={{ fill: "#64748b" }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                fontSize: "12px",
                color: "#0f172a",
              }}
            />
            {activeSeries.includes("Sent") && (
              <Area type="monotone" dataKey="Sent" stroke="#6B72FF" strokeWidth={2} fill="url(#gradSent)" dot={false} isAnimationActive={false} />
            )}
            {activeSeries.includes("Replies") && (
              <Area type="monotone" dataKey="Replies" stroke="#10b981" strokeWidth={2} fill="url(#gradReplies)" dot={false} isAnimationActive={false} />
            )}
            {activeSeries.includes("Bounces") && (
              <Area type="monotone" dataKey="Bounces" stroke="#ef4444" strokeWidth={1.5} fill="transparent" dot={false} strokeDasharray="4 2" isAnimationActive={false} />
            )}
            {activeSeries.includes("Positive") && (
              <Area type="monotone" dataKey="Positive" stroke="#f59e0b" strokeWidth={2} fill="transparent" dot={{ r: 3, fill: "#f59e0b", stroke: "#f59e0b" }} isAnimationActive={false} />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
