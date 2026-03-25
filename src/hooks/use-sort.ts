"use client";

import { useState, useMemo } from "react";

type SortDirection = "asc" | "desc";

export interface SortConfig {
  key: string;
  direction: SortDirection;
}

export function useSort<T>(items: T[], defaultKey?: string, defaultDir: SortDirection = "asc") {
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(
    defaultKey ? { key: defaultKey, direction: defaultDir } : null
  );

  const sorted = useMemo(() => {
    if (!sortConfig) return items;
    const { key, direction } = sortConfig;
    return [...items].sort((a, b) => {
      const aVal = getNestedValue(a, key);
      const bVal = getNestedValue(b, key);
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (typeof aVal === "number" && typeof bVal === "number") {
        return direction === "asc" ? aVal - bVal : bVal - aVal;
      }
      const aStr = String(aVal).toLowerCase();
      const bStr = String(bVal).toLowerCase();
      if (aStr < bStr) return direction === "asc" ? -1 : 1;
      if (aStr > bStr) return direction === "asc" ? 1 : -1;
      return 0;
    });
  }, [items, sortConfig]);

  function requestSort(key: string) {
    setSortConfig((prev) => {
      if (prev?.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: "asc" };
    });
  }

  return { sorted, sortConfig, requestSort };
}

function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((acc, part) => acc?.[part], obj);
}
