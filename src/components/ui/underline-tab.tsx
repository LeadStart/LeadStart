"use client";

import { TabsTrigger } from "@/components/ui/tabs";

// Underline tab for the shared `line` Tabs variant: brand-primary active label
// and underline, with an optional trailing count pill. Started on Mailboxes
// (2026-09-28) and shared with the Planner. Token classes only (UI_RULES.md).
// Use inside <TabsList variant="line" className="h-auto w-full justify-start
// gap-6 rounded-none border-b border-border p-0">.
export function UnderlineTab({
  value,
  icon,
  label,
  count,
}: {
  value: string;
  icon?: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <TabsTrigger
      value={value}
      className="gap-2 px-1 pb-2.5 text-[13.5px] text-muted-foreground data-active:text-primary data-active:after:bg-primary data-active:after:opacity-100"
    >
      {icon}
      {label}
      {count != null && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
          {count}
        </span>
      )}
    </TabsTrigger>
  );
}
