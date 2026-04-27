"use client";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type StatCardTone = "default" | "success" | "warning" | "danger";

interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  iconBg?: string;
  valueColor?: string;
  /**
   * Pre-baked color scheme for at-a-glance signals. Sets sensible defaults
   * for icon background + value color when those props aren't provided
   * explicitly. Existing call sites that pass `iconBg`/`valueColor`
   * keep their custom styling — this prop only fills in defaults.
   */
  tone?: StatCardTone;
}

const TONE_DEFAULTS: Record<StatCardTone, { iconBg: string; valueColor: string }> = {
  default: { iconBg: "bg-[#2E37FE]/10", valueColor: "text-[#0f172a]" },
  success: { iconBg: "bg-emerald-50", valueColor: "text-emerald-600" },
  warning: { iconBg: "bg-amber-50", valueColor: "text-amber-600" },
  danger: { iconBg: "bg-red-50", valueColor: "text-red-600" },
};

/**
 * Consistent stat card with vertically aligned layout.
 * Icon top-left, label below, value at bottom — always aligned across a row.
 */
export function StatCard({ label, value, icon, iconBg, valueColor, tone = "default" }: StatCardProps) {
  const defaults = TONE_DEFAULTS[tone];
  const resolvedIconBg = iconBg ?? defaults.iconBg;
  const resolvedValueColor = valueColor ?? defaults.valueColor;

  return (
    <Card className="stat-card stat-card-gold">
      <CardContent className="pt-[18px] pb-[18px] px-5">
        <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg mb-2", resolvedIconBg)}>
          {icon}
        </div>
        <p className="text-[12px] font-semibold text-[#64748b] mt-1">
          {label}
        </p>
        <p className={cn("text-[28px] font-bold leading-tight", resolvedValueColor)} style={{ letterSpacing: '-0.01em' }}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </p>
      </CardContent>
    </Card>
  );
}
