"use client";

import { Calendar } from "lucide-react";
import {
  METRICS_PERIODS,
  PERIOD_LABELS,
  type MetricsPeriod,
} from "@/lib/kpi/period";

// Shared 7d / 30d / All-Time selector for the admin analytics surfaces.
// Styling matches the client-dossier toggle (client-detail-client.tsx) so the
// three admin views read as one system.
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
      {METRICS_PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
            period === p
              ? "bg-[#2E37FE]/20 text-[#6B72FF] border border-[#2E37FE]/20"
              : "bg-muted/50 text-muted-foreground hover:bg-muted"
          }`}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  );
}
