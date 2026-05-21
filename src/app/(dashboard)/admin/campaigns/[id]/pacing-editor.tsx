"use client";

// Inline editor for the per-campaign daily contact cap (lives inside the
// Enrollment Queue card on the campaign detail page). Click "Edit" →
// number input + Save/Cancel. POSTs to /api/admin/campaigns/[id]/update-pacing
// and reloads the page to refresh the queue panel + drain estimate.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Pencil, Check, X } from "lucide-react";
import { appUrl } from "@/lib/api-url";

const DEFAULT_DAILY_CAP = 66;

export function PacingEditor({
  campaignId,
  currentCap,
}: {
  campaignId: string;
  currentCap: number | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    currentCap == null ? DEFAULT_DAILY_CAP : currentCap,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        appUrl(`/api/admin/campaigns/${campaignId}/update-pacing`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            daily_contact_cap: value > 0 ? value : null,
          }),
        },
      );
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setEditing(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setValue(currentCap == null ? DEFAULT_DAILY_CAP : currentCap);
    setError(null);
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
        aria-label="Edit daily cap"
        title="Edit daily contact cap"
      >
        <Pencil size={11} />
        edit
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Input
        type="number"
        min={1}
        value={value}
        onChange={(e) =>
          setValue(Math.max(1, parseInt(e.target.value) || 1))
        }
        disabled={saving || isPending}
        className="h-7 w-20 text-xs"
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
        onClick={handleSave}
        disabled={saving || isPending}
        aria-label="Save"
      >
        {saving || isPending ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Check size={12} />
        )}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
        onClick={handleCancel}
        disabled={saving || isPending}
        aria-label="Cancel"
      >
        <X size={12} />
      </Button>
      {error && (
        <span className="text-xs text-red-600 ml-1">{error}</span>
      )}
    </span>
  );
}
