"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SimDay } from "@/lib/planner/engine";
import type { TimelineRow } from "@/lib/planner/timeline";
import { formatCivilDate } from "@/lib/format";

// Same axis, grid and tooltip treatment as charts/daily-chart.tsx (soft
// tooltip shadow, no gradients). Daily sends are stacked bars, not areas:
// Monday pile-ups make a stepped area a wall of spikes at this width.
const AXIS = { fontSize: 11, tick: { fill: "#64748b" }, tickLine: false } as const;
const TOOLTIP_STYLE = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  boxShadow: "0 1px 3px rgba(15,23,42,0.08)",
  fontSize: "12px",
  color: "#0f172a",
};
export const SERIES = {
  first: { color: "#2E37FE", label: "First emails" },
  follow: { color: "#14b8a6", label: "Follow-ups" },
  capacity: { color: "#94a3b8", label: "Inbox capacity" },
  month: { color: "#2E37FE", label: "Contacts that month" },
  toDate: { color: "#14b8a6", label: "Contacts to date" },
};

export function Legend({ keys }: { keys: (keyof typeof SERIES)[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      {keys.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES[k].color }} />
          {SERIES[k].label}
        </span>
      ))}
    </div>
  );
}

/** Sends per sending day: first emails + follow-ups as stacked bars, with the inboxes' combined cap. */
export function SendsChart({ days, height = 260 }: { days: SimDay[]; height?: number }) {
  const data = days
    .filter((d) => d.sendDay)
    .map((d) => ({
      date: formatCivilDate(d.date, { year: false }),
      first: d.firstTouches,
      follow: d.followUps,
      capacity: d.capacity,
    }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barCategoryGap={1}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="date" {...AXIS} axisLine={{ stroke: "#e2e8f0" }} minTickGap={24} />
        <YAxis {...AXIS} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(148,163,184,0.12)" }} />
        <Bar dataKey="first" name={SERIES.first.label} stackId="sends" fill={SERIES.first.color} fillOpacity={0.8} isAnimationActive={false} />
        <Bar
          dataKey="follow"
          name={SERIES.follow.label}
          stackId="sends"
          fill={SERIES.follow.color}
          fillOpacity={0.8}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
        <Line
          type="stepAfter"
          dataKey="capacity"
          name={SERIES.capacity.label}
          stroke={SERIES.capacity.color}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Over time: contacts each month (bars, left axis) and contacts to date (line, right axis). */
export function TimelineChart({ rows, height = 240 }: { rows: TimelineRow[]; height?: number }) {
  const data = rows
    .filter((r) => r.month > 0)
    .map((r) => ({ month: `Mo ${r.month}`, month_: Math.round(r.contacts), toDate: Math.round(r.contactsToDate) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: -8, bottom: 0, left: -12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis dataKey="month" {...AXIS} axisLine={{ stroke: "#e2e8f0" }} />
        <YAxis yAxisId="month" {...AXIS} axisLine={false} allowDecimals={false} />
        <YAxis yAxisId="total" orientation="right" {...AXIS} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(148,163,184,0.12)" }} />
        <Bar
          yAxisId="month"
          dataKey="month_"
          name={SERIES.month.label}
          fill={SERIES.month.color}
          fillOpacity={0.8}
          radius={[3, 3, 0, 0]}
          isAnimationActive={false}
        />
        <Line
          yAxisId="total"
          type="monotone"
          dataKey="toDate"
          name={SERIES.toDate.label}
          stroke={SERIES.toDate.color}
          strokeWidth={2}
          dot={{ r: 2.5, fill: SERIES.toDate.color }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** One inbox's daily cap over its first send days when it sends its full allowance. */
export function RampChart({ caps, height = 180 }: { caps: number[]; height?: number }) {
  const data = caps.map((cap, i) => ({ day: `Day ${i + 1}`, cap }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis dataKey="day" {...AXIS} axisLine={{ stroke: "#e2e8f0" }} interval={3} />
        <YAxis {...AXIS} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v} emails`, "Daily cap"]} />
        <Bar dataKey="cap" fill={SERIES.first.color} fillOpacity={0.75} radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
