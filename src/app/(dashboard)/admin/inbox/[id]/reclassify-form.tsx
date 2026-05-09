"use client";

import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle2, UserCheck } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { ReplyClass } from "@/types/app";

const RECLASSIFY_OPTIONS: { value: ReplyClass; label: string }[] = [
  { value: "true_interest", label: "Interested" },
  { value: "meeting_booked", label: "Meeting Booked" },
  { value: "qualifying_question", label: "Has Question" },
  { value: "referral_forward", label: "Referral" },
  { value: "objection_price", label: "Price Concern" },
  { value: "objection_timing", label: "Timing Concern" },
  { value: "wrong_person_no_referral", label: "Wrong Person" },
  { value: "ooo", label: "Out of Office" },
  { value: "not_interested", label: "Not Interested" },
  { value: "unsubscribe", label: "Unsubscribed" },
];

export function ReclassifyForm({
  replyId,
  currentClass,
}: {
  replyId: string;
  currentClass: ReplyClass | null;
}) {
  const [newClass, setNewClass] = useState<ReplyClass | "">("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [localCurrent, setLocalCurrent] = useState<ReplyClass | null>(
    currentClass,
  );

  async function handleReclassify() {
    if (!newClass || newClass === localCurrent) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(appUrl(`/api/replies/${replyId}/reclassify`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ final_class: newClass }),
      });
      const data = await res.json();
      if (res.ok) {
        setSaved(true);
        setLocalCurrent(newClass);
        setNewClass("");
        setTimeout(() => setSaved(false), 2000);
      } else {
        console.error("[reclassify] save failed:", data);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <UserCheck size={14} className="text-muted-foreground" />
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Reclassify
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Override the classifier. Useful for <code>needs_review</code> items or
        training-data correction. Does not re-notify the client.
      </p>
      <div className="flex items-center gap-2">
        <Select
          value={newClass}
          onValueChange={(v) => setNewClass((v as ReplyClass) || "")}
        >
          <SelectTrigger className="h-9 flex-1 text-sm">
            <SelectValue placeholder="Choose new class" />
          </SelectTrigger>
          <SelectContent>
            {RECLASSIFY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          onClick={handleReclassify}
          disabled={!newClass || newClass === localCurrent || saving}
          className="btn-blue px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "Saving..." : "Apply"}
        </button>
      </div>
      {saved && (
        <p className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
          <CheckCircle2 size={12} /> Reclassified
        </p>
      )}
    </div>
  );
}
