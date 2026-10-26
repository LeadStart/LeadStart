"use client";

import { Calendar } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  METRICS_PERIODS,
  PERIOD_LABELS,
  type MetricsPeriod,
} from "@/lib/kpi/period";

// Shared 7d / 30d / All-Time selector for the admin analytics surfaces (Overview
// and All Campaigns), drawn as the shared segmented Tabs control (task #228).
export function PeriodToggle({
  period,
  onChange,
  className = "",
}: {
  period: MetricsPeriod;
  onChange: (p: MetricsPeriod) => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Calendar size={14} className="text-muted-foreground" />
      <Tabs value={period} onValueChange={(v) => onChange(v as MetricsPeriod)}>
        <TabsList>
          {METRICS_PERIODS.map((p) => (
            <TabsTrigger key={p} value={p}>
              {PERIOD_LABELS[p]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
