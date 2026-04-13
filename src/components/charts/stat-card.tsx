"use client";

import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  iconBg?: string;
  valueColor?: string;
}

/**
 * Consistent stat card with vertically aligned layout.
 * Icon top-left, label below, value at bottom — always aligned across a row.
 */
export function StatCard({ label, value, icon, iconBg, valueColor }: StatCardProps) {
  return (
    <Card className="stat-card stat-card-gold">
      <CardContent className="pt-[18px] pb-[18px] px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg mb-2">
          {icon}
        </div>
        <p className="text-[12px] font-semibold text-[#64748b] mt-1">
          {label}
        </p>
        <p className="text-[28px] font-bold leading-tight text-[#0f172a]" style={{ letterSpacing: '-0.01em' }}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </p>
      </CardContent>
    </Card>
  );
}
