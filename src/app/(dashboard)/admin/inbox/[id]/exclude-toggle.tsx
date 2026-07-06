"use client";

// Owner-side "exclude from stats" toggle on the admin reply detail page. Same
// endpoint the client dossier uses — flips lead_replies.excluded_from_stats so
// the native analytics roll-up stops counting this lead.

import { useState } from "react";
import { appUrl } from "@/lib/api-url";

export function ExcludeToggle({
  replyId,
  initialExcluded,
}: {
  replyId: string;
  initialExcluded: boolean;
}) {
  const [excluded, setExcluded] = useState(initialExcluded);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    const next = !excluded;
    setSaving(true);
    try {
      const res = await fetch(appUrl(`/api/replies/${replyId}/exclude`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: next }),
      });
      if (res.ok) setExcluded(next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${
        excluded ? "border-amber-200 bg-amber-50/50" : "border-border/60"
      }`}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {excluded ? "Excluded from stats" : "Counted in stats"}
        </p>
        <p className="text-xs text-muted-foreground">
          {excluded
            ? "This lead is not counted in the client's metrics."
            : "Exclude a junk or misclassified lead from the client's metrics."}
        </p>
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={saving}
        className="shrink-0 rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50 cursor-pointer"
      >
        {saving ? "…" : excluded ? "Include" : "Exclude"}
      </button>
    </div>
  );
}
