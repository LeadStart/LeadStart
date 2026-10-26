"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

interface PaginationControlsProps {
  currentPage: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

export function PaginationControls({
  currentPage,
  totalItems,
  pageSize,
  onPageChange,
}: PaginationControlsProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const clampedPage = Math.min(Math.max(1, currentPage), totalPages);
  const start = totalItems === 0 ? 0 : (clampedPage - 1) * pageSize + 1;
  const end = Math.min(clampedPage * pageSize, totalItems);
  const atStart = clampedPage <= 1;
  const atEnd = clampedPage >= totalPages;

  if (totalItems <= pageSize) return null;

  return (
    <div className="flex items-center justify-between gap-3 px-2 pt-3 pb-1 text-xs text-muted-foreground">
      <p className="whitespace-nowrap">
        <span className="font-medium text-foreground">{start}–{end}</span>{" "}
        of <span className="font-medium text-foreground">{totalItems.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(clampedPage - 1)}
          disabled={atStart}
          className="flex h-[30px] items-center gap-1 rounded-full border border-border bg-card bg-(image:--tex-white) px-3 text-[12.5px] font-semibold text-foreground transition-[filter] hover:brightness-[0.975] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
          aria-label="Previous page"
        >
          <ChevronLeft size={14} />
          Prev
        </button>
        <button
          type="button"
          onClick={() => onPageChange(clampedPage + 1)}
          disabled={atEnd}
          className="flex h-[30px] items-center gap-1 rounded-full border border-border bg-card bg-(image:--tex-white) px-3 text-[12.5px] font-semibold text-foreground transition-[filter] hover:brightness-[0.975] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
          aria-label="Next page"
        >
          Next
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
