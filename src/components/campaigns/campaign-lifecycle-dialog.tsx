"use client";

// Confirm dialog for completing or reopening a campaign. Shared by the Campaigns
// list ⋯ menu and the campaign page, so both show the same summary (GET
// /api/admin/campaigns/[id]/complete) and hit the same endpoints: POST /complete
// stops sending and frees the campaign's inboxes; POST /resume reopens it, which
// the server refuses while another campaign holds one of its inboxes.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, CheckCircle2, Info, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { appUrl } from "@/lib/api-url";
import type { LifecycleSummary } from "@/lib/campaigns/lifecycle";

export type LifecycleDialogMode = "complete" | "reopen";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function CampaignLifecycleDialog({
  mode,
  campaignId,
  campaignName,
  open,
  onOpenChange,
  onDone,
}: {
  mode: LifecycleDialogMode;
  campaignId: string;
  campaignName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Fired after the campaign is completed or reopened.
  onDone: () => void;
}) {
  const [summary, setSummary] = useState<LifecycleSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the summary each time the dialog opens; the close handler resets it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(appUrl(`/api/admin/campaigns/${campaignId}/complete`))
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as LifecycleSummary & { error?: string };
        if (cancelled) return;
        if (!res.ok) setLoadError(json.error || `Couldn't load the campaign (${res.status})`);
        else setSummary(json);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, campaignId]);

  function reset() {
    setSummary(null);
    setLoadError(null);
    setError(null);
  }

  function change(next: boolean) {
    if (busy) return; // don't let the dialog close mid-request
    if (!next) reset();
    onOpenChange(next);
  }

  const conflicts = summary?.conflicts ?? [];
  const blocked = mode === "reopen" && conflicts.length > 0;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        appUrl(`/api/admin/campaigns/${campaignId}/${mode === "complete" ? "complete" : "resume"}`),
        { method: "POST" },
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      const inboxCount = summary?.inboxes.length ?? 0;
      if (mode === "complete") {
        toast.success(`Completed "${campaignName}"`, {
          description:
            inboxCount > 0
              ? `${plural(inboxCount, "inbox is", "inboxes are")} free for other campaigns.`
              : "Sending has stopped.",
        });
      } else {
        toast.success(`Reopened "${campaignName}"`, {
          description: "Sending resumes on the next cron tick inside the send window.",
        });
      }
      reset();
      onOpenChange(false);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const inboxList = summary?.inboxes.map((m) => m.email).join(", ") ?? "";

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{mode === "complete" ? "Complete campaign?" : "Reopen campaign?"}</DialogTitle>
          <DialogDescription>
            {mode === "complete" ? (
              <>
                <span className="font-semibold text-foreground">{campaignName}</span> stops sending
                and gives its inboxes back, so another campaign can use them. You can reopen it
                later.
              </>
            ) : (
              <>
                <span className="font-semibold text-foreground">{campaignName}</span> goes back to
                active and takes its inboxes back. It sends again on the next cron tick inside its
                send window.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!summary && !loadError && (
          <p className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Checking the campaign…
          </p>
        )}
        {loadError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-xs font-semibold text-red-700">Couldn&apos;t load the campaign</p>
            <p className="mt-1 text-xs break-words text-red-700/90">{loadError}</p>
          </div>
        )}

        {summary && (
          <ul className="space-y-2 py-1">
            {blocked && (
              <li className="flex items-start gap-2 text-sm">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
                <span className="text-red-700">
                  {conflicts.length === 1
                    ? "One of its inboxes is now used by another campaign: "
                    : `${conflicts.length} of its inboxes are now used by other campaigns: `}
                  {conflicts.map((c) => `${c.email} ("${c.campaignName}")`).join(", ")}. Take{" "}
                  {conflicts.length === 1 ? "it" : "them"} out of this campaign&apos;s inboxes (or
                  off the other campaign), then reopen.
                </span>
              </li>
            )}
            <li className="flex items-start gap-2 text-sm">
              <Info size={16} className="mt-0.5 shrink-0 text-slate-400" />
              <span className="text-slate-600">
                {summary.inboxes.length === 0
                  ? mode === "complete"
                    ? "It holds no inboxes."
                    : "It has no inboxes. Add some on its Setup tab before it can send."
                  : `${mode === "complete" ? "Frees" : "Takes back"} ${plural(
                      summary.inboxes.length,
                      "inbox",
                      "inboxes",
                    )}: ${inboxList}`}
              </span>
            </li>
            {summary.unfinished > 0 ? (
              <li className="flex items-start gap-2 text-sm">
                <AlertTriangle
                  size={16}
                  className={`mt-0.5 shrink-0 ${mode === "complete" ? "text-amber-600" : "text-slate-400"}`}
                />
                <span className={mode === "complete" ? "text-amber-800" : "text-slate-600"}>
                  {mode === "complete"
                    ? `${plural(summary.unfinished, "contact is", "contacts are")} still mid-sequence and get no more emails unless you reopen it.`
                    : `${plural(summary.unfinished, "contact picks", "contacts pick")} up where they stopped.`}
                </span>
              </li>
            ) : (
              <li className="flex items-start gap-2 text-sm">
                <Info size={16} className="mt-0.5 shrink-0 text-slate-400" />
                <span className="text-slate-600">
                  {mode === "complete"
                    ? "No contacts are mid-sequence."
                    : "No contacts are waiting; it sends once you add some."}
                </span>
              </li>
            )}
          </ul>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-xs font-semibold text-red-700">
              Couldn&apos;t {mode === "complete" ? "complete" : "reopen"} the campaign
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
          <Button onClick={confirm} disabled={busy || !summary || blocked}>
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : mode === "complete" ? (
              <CheckCircle2 size={14} />
            ) : (
              <RotateCcw size={14} />
            )}
            {mode === "complete" ? "Complete campaign" : "Reopen campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
