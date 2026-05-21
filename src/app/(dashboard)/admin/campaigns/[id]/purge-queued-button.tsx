"use client";

// Bulk-delete button for contacts that are "scheduled to be sent" — i.e.
// contacts on this campaign with status='queued' (queue row pending,
// not yet pushed to Salesforge). Lives in the Enrollment Queue card on
// the campaign detail page. Rendered only when pending > 0.
//
// On confirm, POSTs to /api/admin/campaigns/[id]/purge-queued. The route
// deletes contact rows; salesforge_enrollment_queue cascades via FK.
// router.refresh() re-renders the page so the queue stats + contacts
// table update without a full reload.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Trash2 } from "lucide-react";
import { appUrl } from "@/lib/api-url";

export function PurgeQueuedButton({
  campaignId,
  pendingCount,
}: {
  campaignId: string;
  pendingCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleClick() {
    if (
      !confirm(
        `Delete ${pendingCount.toLocaleString()} queued contact${
          pendingCount === 1 ? "" : "s"
        } from this campaign?\n\n` +
          `These contacts have NOT yet been pushed to Salesforge. ` +
          `Deleting removes them from LeadStart entirely (contact row + queue row). ` +
          `Re-import via CSV if you change your mind.\n\n` +
          `This does not affect contacts that have already been sent to.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        appUrl(`/api/admin/campaigns/${campaignId}/purge-queued`),
        { method: "POST" },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        deleted?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const working = busy || isPending;

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={working}
        className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
        title={`Delete all ${pendingCount} pending contacts from this campaign`}
      >
        {working ? (
          <>
            <Loader2 size={14} className="mr-1 animate-spin" /> Deleting…
          </>
        ) : (
          <>
            <Trash2 size={14} className="mr-1" /> Clear queued ({pendingCount})
          </>
        )}
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
