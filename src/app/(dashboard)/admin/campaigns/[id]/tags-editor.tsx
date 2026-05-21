"use client";

// Inline editor for campaigns.salesforge_default_tags. Shown next to
// the pacing editor in the queue card. Salesforge requires every
// contact to carry at least one tag on bulk-create — these get sent
// by the dispatcher on every contact it pushes for this campaign.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Pencil, Check, X } from "lucide-react";
import { appUrl } from "@/lib/api-url";

function joinTags(tags: string[] | null): string {
  return (tags ?? []).join(", ");
}

function splitTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function TagsEditor({
  campaignId,
  currentTags,
}: {
  campaignId: string;
  currentTags: string[] | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(joinTags(currentTags));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const tags = splitTags(value);
      const res = await fetch(
        appUrl(`/api/admin/campaigns/${campaignId}/update-tags`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags: tags.length > 0 ? tags : null }),
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
    setValue(joinTags(currentTags));
    setError(null);
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
        aria-label="Edit Salesforge tags"
        title="Edit the tags Salesforge attaches to every contact this campaign pushes"
      >
        <Pencil size={11} />
        edit
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="comma, separated, tags"
        disabled={saving || isPending}
        className="h-7 w-56 text-xs"
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
