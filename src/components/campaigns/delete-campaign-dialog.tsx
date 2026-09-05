"use client";

// Shared typed-confirmation delete dialog for a campaign: the single source of
// truth so the Campaigns list row-actions menu and the campaign Setup tab present
// an identical modal and hit the same owner-only /delete endpoint. The caller owns
// the open state and decides what happens after a successful delete (the list
// re-fetches in place; the detail page navigates back to the list, since the row
// no longer exists).

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { appUrl } from "@/lib/api-url";

export function DeleteCampaignDialog({
  campaignId,
  campaignName,
  open,
  onOpenChange,
  onDeleted,
}: {
  campaignId: string;
  campaignName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Fired after the campaign is deleted.
  onDeleted: () => void;
}) {
  const [typedName, setTypedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmEnabled = typedName.trim() === campaignName.trim();

  function change(next: boolean) {
    if (busy) return; // don't let the dialog close mid-delete
    onOpenChange(next);
    if (!next) {
      setTypedName("");
      setError(null);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/delete`), {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || `Delete failed (${res.status})`);
      toast.success(`Deleted "${campaignName}"`, {
        description: "Campaign removed from LeadStart.",
      });
      setTypedName("");
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-red-700">Delete campaign?</DialogTitle>
          <DialogDescription>
            This permanently removes{" "}
            <span className="font-semibold text-foreground">{campaignName}</span> from
            LeadStart. Lead replies and contacts tied to this campaign are preserved but
            lose their campaign link. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label
            htmlFor={`confirm-delete-${campaignId}`}
            className="text-xs font-medium text-muted-foreground"
          >
            Type <span className="font-semibold text-foreground">{campaignName}</span> to
            confirm:
          </label>
          <Input
            id={`confirm-delete-${campaignId}`}
            autoFocus
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder={campaignName}
            disabled={busy}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-xs font-semibold text-red-700">
              Couldn&apos;t delete the campaign
            </p>
            <p className="mt-1 max-h-28 overflow-y-auto text-xs break-words whitespace-pre-wrap text-red-700/90">
              {error}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => change(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!confirmEnabled || busy}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
