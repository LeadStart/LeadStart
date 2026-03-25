"use client";

import { TableHead } from "@/components/ui/table";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import type { SortConfig } from "@/hooks/use-sort";

interface SortableHeadProps {
  label?: string;
  children?: React.ReactNode;
  sortKey: string;
  sortConfig: SortConfig | null;
  onSort: (key: string) => void;
  className?: string;
}

export function SortableHead({ label, children, sortKey, sortConfig, onSort, className }: SortableHeadProps) {
  const isActive = sortConfig?.key === sortKey;
  const Icon = isActive
    ? sortConfig?.direction === "asc" ? ArrowUp : ArrowDown
    : ArrowUpDown;

  return (
    <TableHead
      className={`cursor-pointer select-none hover:text-foreground transition-colors ${className || ""}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {children || label}
        <Icon size={13} className={isActive ? "text-indigo-500" : "text-muted-foreground/50"} />
      </span>
    </TableHead>
  );
}
