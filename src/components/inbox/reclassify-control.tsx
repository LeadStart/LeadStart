"use client";

// Admin-only: turns the reply-class taxonomy into a QuickActionGroup for the
// inbox action bar. Six common classes render as one-click buttons; the full
// list lives behind a "More…" dropdown. Every choice POSTs the existing
// reclassify route (owner/VA only, does NOT re-notify the client) and calls
// onChanged so the surface can update its local row.

import { useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { appUrl } from "@/lib/api-url";
import { CLASS_META } from "@/lib/replies/ui";
import type { ReplyClass } from "@/types/app";
import type { QuickActionGroup } from "./quick-action-bar";

// badge utility class → accent hex (mirrors globals.css .badge-*).
const BADGE_HEX: Record<string, string> = {
  "badge-green": "#059669",
  "badge-amber": "#d97706",
  "badge-red": "#dc2626",
  "badge-blue": "#2E37FE",
  "badge-purple": "#7c3aed",
  "badge-slate": "#475569",
};
export function classAccent(cls: ReplyClass): string {
  return BADGE_HEX[CLASS_META[cls].badge] ?? "#475569";
}

// Common classes surfaced as one-click buttons (priority order); the rest are
// reachable via the More… dropdown.
const QUICK_CLASSES: ReplyClass[] = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
  "objection_price",
  "not_interested",
  "needs_review",
];

// Full taxonomy for the dropdown (excludes nothing the reclassify route rejects).
const ALL_CLASSES: ReplyClass[] = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
  "referral_forward",
  "objection_price",
  "objection_timing",
  "needs_review",
  "wrong_person_no_referral",
  "ooo",
  "not_interested",
  "unsubscribe",
];

export function useReclassifyGroup({
  replyId,
  currentClass,
  onChanged,
}: {
  replyId: string;
  currentClass: ReplyClass | null;
  onChanged: (cls: ReplyClass) => void;
}): { group: QuickActionGroup; saving: boolean } {
  const [saving, setSaving] = useState(false);

  async function apply(cls: ReplyClass) {
    if (cls === currentClass || saving) return;
    setSaving(true);
    try {
      const res = await fetch(appUrl(`/api/replies/${replyId}/reclassify`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ final_class: cls }),
      });
      const data = await res.json();
      if (res.ok) onChanged(cls);
      else console.error("[reclassify] save failed:", data);
    } finally {
      setSaving(false);
    }
  }

  const group: QuickActionGroup = {
    label: "Tag this reply (reclassify)",
    actions: QUICK_CLASSES.map((cls) => ({
      key: cls,
      label: CLASS_META[cls].label,
      color: classAccent(cls),
      active: currentClass === cls,
      disabled: saving,
      onClick: () => apply(cls),
    })),
    hint: (
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={saving}
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted cursor-pointer disabled:opacity-50"
        >
          More… <ChevronDown size={12} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {ALL_CLASSES.map((cls) => (
            <DropdownMenuItem
              key={cls}
              onClick={() => apply(cls)}
              className="flex items-center gap-2.5 cursor-pointer"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                style={{ background: classAccent(cls) }}
              />
              <span className="flex-1">{CLASS_META[cls].label}</span>
              {currentClass === cls && <Check size={14} className="text-[#2E37FE]" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  };

  return { group, saving };
}
