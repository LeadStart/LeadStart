"use client";

import { Card, CardContent } from "@/components/ui/card";
import { getKPIHealth, KPI_DEFINITIONS } from "@/lib/kpi/definitions";
import type { KPIHealth } from "@/types/app";
import { cn } from "@/lib/utils";

interface KPICardProps {
  label: string;
  value: number;
  unit: "percent" | "count";
  kpiKey?: string;
  subtitle?: string;
  /** Accepted for call-site compatibility; not rendered in the centered layout. */
  icon?: React.ReactNode;
}

// Health drives only the top accent bar now — the old corner "Good/Warning/Bad"
// pill is gone, leaving one calm health signal. Neutral (no kpiKey) uses brand.
function accentClass(health: KPIHealth | null): string {
  switch (health) {
    case "good":
      return "bg-emerald-500";
    case "warning":
      return "bg-amber-500";
    case "bad":
      return "bg-red-500";
    default:
      return "bg-primary";
  }
}

export function KPICard({ label, value, unit, kpiKey, subtitle }: KPICardProps) {
  let health: KPIHealth | null = null;
  if (kpiKey) {
    const def = KPI_DEFINITIONS.find((d) => d.key === kpiKey);
    if (def) health = getKPIHealth(def, value);
  }

  const formattedValue = unit === "percent" ? `${value}%` : value.toLocaleString();

  return (
    <Card className="relative overflow-hidden border-border/60 h-full">
      {/* Top accent bar — the sole health signal */}
      <div className={cn("absolute top-0 left-0 right-0 h-1", accentClass(health))} />

      {/* Centered composition: label above, prominent number, optional
          descriptor below — balanced whitespace, no left-aligned dead space. */}
      <CardContent className="flex min-h-[128px] flex-col items-center justify-center px-4 py-6 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="mt-2 text-4xl font-bold tracking-tight tabular-nums text-foreground">
          {formattedValue}
        </p>
        {subtitle && (
          <p className="mt-2 text-xs text-muted-foreground">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}
