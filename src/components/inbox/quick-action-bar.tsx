"use client";

// The pinned one-click action bar from inbox direction #5. Generic: each
// surface passes its own groups of buttons. Admin passes a "reclassify tags"
// group; the client passes "log outcome" (+ call/reply). An active button
// fills with its accent colour; the rest are hairline chips.

import type { ReactNode } from "react";

export interface QuickAction {
  key: string;
  label: string;
  color?: string; // accent hex; used as fill when active, dot otherwise
  active?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  onClick: () => void;
}

export interface QuickActionGroup {
  label: string;
  hint?: ReactNode; // optional trailing node (e.g. a "More…" dropdown)
  actions: QuickAction[];
}

export function QuickActionBar({ groups }: { groups: QuickActionGroup[] }) {
  return (
    <div className="flex flex-none flex-col gap-2.5 border-b border-border/60 bg-card px-4 py-3 sm:px-5">
      {groups.map((group, gi) => (
        <div key={gi} className="flex flex-col gap-1.5">
          <p className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
            {group.label}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {group.actions.map((a) => (
              <button
                key={a.key}
                onClick={a.onClick}
                disabled={a.disabled}
                className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                style={
                  a.active
                    ? { background: a.color ?? "#0f172a", color: "#fff", borderColor: "transparent" }
                    : { background: "#fff", color: "#0f172a", borderColor: "var(--border)" }
                }
              >
                {a.icon ?? (
                  a.color && (
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: a.active ? "#fff" : a.color }}
                    />
                  )
                )}
                {a.label}
              </button>
            ))}
            {group.hint}
          </div>
        </div>
      ))}
    </div>
  );
}
