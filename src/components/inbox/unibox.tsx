"use client";

import { BackButton } from "@/components/layout/back-button";

// Shared two-pane "unibox" shell for the admin + client inboxes (direction #5).
// Desktop: sender list left, conversation + action bar right. Mobile: it's
// master-detail — the list is full-width until a reply is opened, then the
// thread takes over full-width with a Back control. Height is a viewport calc
// so each pane scrolls internally instead of the whole page.

import type { ReactNode } from "react";

export function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "•";
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

export function Unibox({
  list,
  detail,
  hasSelection,
}: {
  list: ReactNode;
  detail: ReactNode;
  hasSelection: boolean;
}) {
  return (
    <div className="flex h-[calc(100dvh-11.5rem)] min-h-[460px] overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm lg:h-[calc(100dvh-8.5rem)]">
      {/* List — full width on mobile, fixed rail on sm+. Hidden on mobile once
          a reply is open. */}
      <div
        className={`w-full flex-col border-border/60 sm:flex sm:max-w-[380px] sm:shrink-0 sm:border-r ${
          hasSelection ? "hidden sm:flex" : "flex"
        }`}
      >
        {list}
      </div>
      {/* Detail — hidden on mobile until a reply is open. */}
      <div
        className={`min-h-0 min-w-0 flex-1 flex-col sm:flex ${
          hasSelection ? "flex" : "hidden sm:flex"
        }`}
      >
        {detail}
      </div>
    </div>
  );
}

export function UniboxListHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-none flex-col gap-2.5 border-b border-border/60 p-3">
      {children}
    </div>
  );
}

export function UniboxListScroll({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

export function ReplyListRow({
  id,
  selected,
  onClick,
  accent,
  monogram,
  name,
  sub,
  snippet,
  time,
  badges,
  unread,
}: {
  id?: string;
  selected: boolean;
  onClick: () => void;
  accent: string;
  monogram: string;
  name: string;
  sub?: ReactNode;
  snippet?: string | null;
  time: string;
  badges?: ReactNode;
  unread?: boolean;
}) {
  return (
    <button
      data-reply-id={id}
      onClick={onClick}
      className={`relative flex w-full items-start gap-3 border-b border-border/60 px-3.5 py-3 text-left transition-colors cursor-pointer hover:bg-muted/40 ${
        selected ? "bg-[#2E37FE]/[0.06]" : ""
      }`}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-[3px] bg-[#2E37FE]" />}
      <span
        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
        style={{ background: accent }}
      >
        {monogram}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-[#2E37FE]" />}
          <span className="truncate text-[13px] font-semibold text-foreground">{name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{time}</span>
        </span>
        {sub && <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">{sub}</span>}
        {snippet && (
          <span className="mt-1 block truncate text-[12.5px] text-muted-foreground/90">{snippet}</span>
        )}
        {badges && <span className="mt-1.5 flex flex-wrap items-center gap-1.5">{badges}</span>}
      </span>
    </button>
  );
}

export function ThreadEmpty({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
      {children ?? "Select a reply to read the conversation"}
    </div>
  );
}

// Mobile-only "back to list" affordance rendered inside a thread header.
export function MobileBack({ onBack }: { onBack: () => void }) {
  return (
    <BackButton
      onClick={onBack}
      label="Back to inbox"
      className="mb-1 h-8 w-8 sm:hidden"
    />
  );
}
