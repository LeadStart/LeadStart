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
export function StatCard({ label, value, icon, iconBg = "bg-indigo-50", valueColor }: StatCardProps) {
  return (
    <Card className="border-border/50 shadow-sm">
      <CardContent className="pt-5 pb-4 px-5">
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${iconBg} mb-3`}>
          {icon}
        </div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          {label}
        </p>
        <p className={`text-2xl font-bold ${valueColor || "text-foreground"}`}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </p>
      </CardContent>
    </Card>
  );
}
