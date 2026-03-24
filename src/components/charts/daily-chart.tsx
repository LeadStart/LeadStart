"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CampaignSnapshot } from "@/types/app";

interface DailyChartProps {
  snapshots: CampaignSnapshot[];
  title?: string;
}

export function DailyChart({ snapshots, title = "Daily Performance" }: DailyChartProps) {
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
      Meetings: s.meetings_booked,
    }));

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#6366f1]" /> Sent
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#10b981]" /> Replies
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#ef4444]" /> Bounces
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#f59e0b]" /> Meetings
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="gradSent" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradReplies" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="date"
              fontSize={11}
              tick={{ fill: "#9ca3af" }}
              axisLine={{ stroke: "#e5e7eb" }}
              tickLine={false}
            />
            <YAxis
              fontSize={11}
              tick={{ fill: "#9ca3af" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "white",
                border: "1px solid #e5e7eb",
                borderRadius: "8px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                fontSize: "12px",
              }}
            />
            <Area
              type="monotone"
              dataKey="Sent"
              stroke="#6366f1"
              strokeWidth={2}
              fill="url(#gradSent)"
              dot={false}
            />
            <Area
              type="monotone"
              dataKey="Replies"
              stroke="#10b981"
              strokeWidth={2}
              fill="url(#gradReplies)"
              dot={false}
            />
            <Area
              type="monotone"
              dataKey="Bounces"
              stroke="#ef4444"
              strokeWidth={1.5}
              fill="transparent"
              dot={false}
              strokeDasharray="4 2"
            />
            <Area
              type="monotone"
              dataKey="Meetings"
              stroke="#f59e0b"
              strokeWidth={2}
              fill="transparent"
              dot={{ r: 3, fill: "#f59e0b", stroke: "#f59e0b" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
