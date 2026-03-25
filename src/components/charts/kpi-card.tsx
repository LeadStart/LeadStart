"use client";

import { Card, CardContent } from "@/components/ui/card";
import { getKPIHealth, KPI_DEFINITIONS } from "@/lib/kpi/definitions";
import type { KPIHealth } from "@/types/app";
import { TrendingUp, TrendingDown, Minus, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface KPICardProps {
  label: string;
  value: number;
  unit: "percent" | "count";
  kpiKey?: string;
  subtitle?: string;
  icon?: React.ReactNode;
}

function getHealthStyles(health: KPIHealth) {
  switch (health) {
    case "good":
      return {
        bg: "bg-emerald-50",
        border: "border-emerald-200",
        text: "text-emerald-700",
        badge: "bg-emerald-100 text-emerald-700",
        icon: <TrendingUp size={14} />,
        indicator: "bg-emerald-500",
      };
    case "warning":
      return {
        bg: "bg-amber-50",
        border: "border-amber-200",
        text: "text-amber-700",
        badge: "bg-amber-100 text-amber-700",
        icon: <Minus size={14} />,
        indicator: "bg-amber-500",
      };
    case "bad":
      return {
        bg: "bg-red-50",
        border: "border-red-200",
        text: "text-red-700",
        badge: "bg-red-100 text-red-700",
        icon: <TrendingDown size={14} />,
        indicator: "bg-red-500",
      };
  }
}

const defaultStyles = {
  bg: "bg-brand-50",
  border: "border-brand-200",
  text: "text-brand-700",
  badge: "bg-brand-100 text-brand-700",
  icon: <ArrowUpRight size={14} />,
  indicator: "bg-brand-500",
};

export function KPICard({ label, value, unit, kpiKey, subtitle, icon }: KPICardProps) {
  let health: KPIHealth | null = null;

  if (kpiKey) {
    const def = KPI_DEFINITIONS.find((d) => d.key === kpiKey);
    if (def) {
      health = getKPIHealth(def, value);
    }
  }

  const styles = health ? getHealthStyles(health) : defaultStyles;
  const formattedValue = unit === "percent" ? `${value}%` : value.toLocaleString();

  return (
    <Card className={cn(
      "relative overflow-hidden border transition-all duration-200 hover:shadow-md h-full",
      styles.border,
    )}>
      {/* Top colored bar */}
      <div className={cn("absolute top-0 left-0 right-0 h-1", styles.indicator)} />

      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {label}
            </p>
            <p className="text-2xl font-bold tracking-tight text-foreground">
              {formattedValue}
            </p>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>

          {/* Health indicator badge */}
          <div className={cn(
            "flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold",
            styles.badge,
          )}>
            {styles.icon}
            {health ? health.charAt(0).toUpperCase() + health.slice(1) : "—"}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
