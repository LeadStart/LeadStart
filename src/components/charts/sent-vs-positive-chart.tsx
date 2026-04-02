"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CampaignSnapshot } from "@/types/app";

interface SentVsPositiveChartProps {
  snapshots: CampaignSnapshot[];
  height?: number;
}

export function SentVsPositiveChart({ snapshots, height = 220 }: SentVsPositiveChartProps) {
  // Aggregate by date (multiple campaigns may have same date)
  const dateMap = new Map<string, { sent: number; positive: number }>();

  for (const s of snapshots) {
    const existing = dateMap.get(s.snapshot_date) || { sent: 0, positive: 0 };
    existing.sent += s.emails_sent;
    existing.positive += s.meetings_booked;
    dateMap.set(s.snapshot_date, existing);
  }

  const data = Array.from(dateMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({
      date: new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      "Emails Sent": vals.sent,
      "Positive Responses": vals.positive,
    }));

  if (data.length === 0) return null;

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">Emails Sent vs Positive Responses</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data} barGap={2}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
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
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: "12px", color: "#6b7280" }}
            />
            <Bar
              dataKey="Emails Sent"
              fill="#6366f1"
              radius={[3, 3, 0, 0]}
              maxBarSize={32}
            />
            <Bar
              dataKey="Positive Responses"
              fill="#10b981"
              radius={[3, 3, 0, 0]}
              maxBarSize={32}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
