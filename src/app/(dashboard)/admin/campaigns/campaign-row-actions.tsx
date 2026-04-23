"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { MoreHorizontal, Pause, Play, Trash2, Loader2 } from "lucide-react";
import { appUrl } from "@/lib/api-url";

type CampaignStatus = "active" | "paused" | "draft" | "completed" | null;

interface CampaignRowActionsProps {
  campaignId: string;
  campaignName: string;
  status: CampaignStatus;
  onChanged: () => void;
}

export function CampaignRowActions({
  campaignId,
  campaignName,
  status,
  onChanged,
}: CampaignRowActionsProps) {
  const [busy, setBusy] = useState<"pause" | "resume" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [typedName, setTypedName] = useState("");

  async function callLifecycle(action: "pause" | "resume" | "delete") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(
        appUrl(`/api/admin/campaigns/${campaignId}/${action}`),
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || `${action} failed (${res.status})`);
      }
      onChanged();
      if (action === "delete") {
        setDeleteOpen(false);
        setTypedName("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const canPause = status === "active";
  const canResume = status === "paused";
  const confirmEnabled = typedName.trim() === campaignName.trim();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors cursor-pointer"
              aria-label="Campaign actions"
            />
          }
        >
          <MoreHorizontal size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canPause && (
            <DropdownMenuItem
              onClick={() => callLifecycle("pause")}
              disabled={busy !== null}
            >
              {busy === "pause" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Pause size={14} />
              )}
              Pause
            </DropdownMenuItem>
          )}
          {canResume && (
            <DropdownMenuItem
              onClick={() => callLifecycle("resume")}
              disabled={busy !== null}
            >
              {busy === "resume" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              Resume
            </DropdownMenuItem>
          )}
          {(canPause || canResume) && <DropdownMenuSeparator />}
          <DropdownMenuItem
            onClick={() => {
              setError(null);
              setTypedName("");
              setDeleteOpen(true);
            }}
            disabled={busy !== null}
            className="text-red-600 focus:text-red-700 data-highlighted:bg-red-50"
          >
            <Trash2 size={14} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {error && !deleteOpen && (
        <p className="absolute right-4 mt-1 text-[11px] text-red-600">{error}</p>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-red-700">
              Delete campaign?
            </DialogTitle>
            <DialogDescription>
              This permanently removes{" "}
              <span className="font-semibold text-foreground">
                {campaignName}
              </span>{" "}
              from Instantly and from LeadStart. Lead replies and contacts
              tied to this campaign are preserved but lose their campaign
              link. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label
              htmlFor={`confirm-delete-${campaignId}`}
              className="text-xs font-medium text-[#64748b]"
            >
              Type <span className="font-mono text-[#0f172a]">{campaignName}</span> to confirm:
            </label>
            <Input
              id={`confirm-delete-${campaignId}`}
              autoFocus
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder={campaignName}
              disabled={busy === "delete"}
            />
          </div>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={busy === "delete"}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => callLifecycle("delete")}
              disabled={!confirmEnabled || busy === "delete"}
            >
              {busy === "delete" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
