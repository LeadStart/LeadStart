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
    <div className="flex items-center justify-between gap-3 px-2 pt-3 pb-1 text-xs text-[#64748b]">
      <p className="whitespace-nowrap">
        <span className="font-medium text-[#0f172a]">{start}–{end}</span>{" "}
        of <span className="font-medium text-[#0f172a]">{totalItems.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(clampedPage - 1)}
          disabled={atStart}
          className="flex h-7 items-center gap-1 rounded-md border border-border/60 bg-white px-2 font-medium text-[#0f172a] transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white"
          aria-label="Previous page"
        >
          <ChevronLeft size={14} />
          Prev
        </button>
        <button
          type="button"
          onClick={() => onPageChange(clampedPage + 1)}
          disabled={atEnd}
          className="flex h-7 items-center gap-1 rounded-md border border-border/60 bg-white px-2 font-medium text-[#0f172a] transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white"
          aria-label="Next page"
        >
          Next
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
