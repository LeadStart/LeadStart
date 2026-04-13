"use client";

import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CampaignSnapshot } from "@/types/app";

interface MonthlyPositiveChartProps {
  snapshots: CampaignSnapshot[];
  height?: number;
}

export function MonthlyPositiveChart({ snapshots, height = 220 }: MonthlyPositiveChartProps) {
  // Aggregate positive responses by month
  const monthMap = new Map<string, number>();

  for (const s of snapshots) {
    const d = new Date(s.snapshot_date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthMap.set(key, (monthMap.get(key) || 0) + s.meetings_booked);
  }

  const allMonths = Array.from(monthMap.keys()).sort();
  if (allMonths.length === 0) return null;

  const WINDOW = 12;
  const maxOffset = Math.max(0, allMonths.length - WINDOW);
  const [offset, setOffset] = useState(maxOffset); // start showing most recent

  const visibleMonths = allMonths.slice(offset, offset + WINDOW);

  const data = visibleMonths.map((month) => {
    const [year, m] = month.split("-");
    const date = new Date(Number(year), Number(m) - 1);
    return {
      month,
      label: date.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
      "Positive Responses": monthMap.get(month) || 0,
    };
  });

  const canGoBack = offset > 0;
  const canGoForward = offset < maxOffset;

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">Positive Responses by Month</CardTitle>
          {allMonths.length > WINDOW && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setOffset((o) => Math.max(0, o - WINDOW))}
                disabled={!canGoBack}
                className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                title="Earlier months"
              >
                <ChevronLeft size={16} className="text-muted-foreground" />
              </button>
              <span className="text-[10px] text-muted-foreground px-1">
                {visibleMonths[0] && new Date(visibleMonths[0] + "-01").toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                {" — "}
                {visibleMonths[visibleMonths.length - 1] && new Date(visibleMonths[visibleMonths.length - 1] + "-01").toLocaleDateString("en-US", { month: "short", year: "numeric" })}
              </span>
              <button
                onClick={() => setOffset((o) => Math.min(maxOffset, o + WINDOW))}
                disabled={!canGoForward}
                className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                title="Later months"
              >
                <ChevronRight size={16} className="text-muted-foreground" />
              </button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis
              dataKey="label"
              fontSize={12}
              tick={{ fill: "#64748b" }}
              axisLine={{ stroke: "#e2e8f0" }}
              tickLine={false}
            />
            <YAxis
              fontSize={11}
              tick={{ fill: "#64748b" }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                fontSize: "12px",
                color: "#0f172a",
              }}
              cursor={{ fill: "rgba(201, 168, 76, 0.06)" }}
            />
            <Bar
              dataKey="Positive Responses"
              fill="#10b981"
              radius={[4, 4, 0, 0]}
              maxBarSize={48}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
