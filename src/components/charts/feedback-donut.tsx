"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

interface FeedbackDonutProps {
  feedback: { status: string }[];
}

const STATUS_CONFIG: Record<string, { label: string; color: string; group: "positive" | "negative" | "neutral" }> = {
  good_lead: { label: "Good Lead", color: "#10b981", group: "positive" },
  interested: { label: "Interested", color: "#34d399", group: "positive" },
  bad_lead: { label: "Bad Lead", color: "#ef4444", group: "negative" },
  wrong_person: { label: "Wrong Person", color: "#f97316", group: "negative" },
  not_interested: { label: "Not Interested", color: "#fb923c", group: "negative" },
  already_contacted: { label: "Already Contacted", color: "#a78bfa", group: "neutral" },
  other: { label: "Other", color: "#94a3b8", group: "neutral" },
};

export function FeedbackDonut({ feedback }: FeedbackDonutProps) {
  if (feedback.length === 0) return null;

  // Count by status
  const counts: Record<string, number> = {};
  feedback.forEach((f) => {
    counts[f.status] = (counts[f.status] || 0) + 1;
  });

  const data = Object.entries(counts)
    .map(([status, count]) => ({
      name: STATUS_CONFIG[status]?.label || status.replace(/_/g, " "),
      value: count,
      color: STATUS_CONFIG[status]?.color || "#94a3b8",
      pct: Math.round((count / feedback.length) * 100),
    }))
    .sort((a, b) => b.value - a.value);

  const positive = feedback.filter((f) =>
    ["good_lead", "interested"].includes(f.status)
  ).length;
  const qualityPct = Math.round((positive / feedback.length) * 100);

  return (
    <div className="flex items-center gap-6">
      {/* Donut */}
      <div className="relative h-[180px] w-[180px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={80}
              paddingAngle={2}
              dataKey="value"
              stroke="none"
            >
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              content={({ payload }) => {
                if (!payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
                    <p className="text-sm font-medium">{d.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {d.value} lead{d.value !== 1 ? "s" : ""} ({d.pct}%)
                    </p>
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {/* Center label */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold">{qualityPct}%</span>
          <span className="text-xs text-muted-foreground">Quality</span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-col gap-1.5">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-2 text-sm">
            <span
              className="inline-block h-3 w-3 rounded-full shrink-0"
              style={{ backgroundColor: d.color }}
            />
            <span className="text-muted-foreground">{d.name}</span>
            <span className="ml-auto font-medium tabular-nums">
              {d.value} <span className="text-muted-foreground font-normal">({d.pct}%)</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
