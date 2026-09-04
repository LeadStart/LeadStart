"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Pause, Play, Rocket, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { appUrl } from "@/lib/api-url";
import { ActivatePreflightDialog } from "@/components/campaigns/activate-preflight-dialog";
import { DeleteCampaignDialog } from "@/components/campaigns/delete-campaign-dialog";
import type { PreflightWarning } from "@/lib/deliverability/preflight";

type CampaignStatus = "active" | "paused" | "draft" | "completed" | null;

interface CampaignRowActionsProps {
  campaignId: string;
  campaignName: string;
  status: CampaignStatus;
  sourceChannel?: string;
  onChanged: () => void;
}

export function CampaignRowActions({
  campaignId,
  campaignName,
  status,
  sourceChannel,
  onChanged,
}: CampaignRowActionsProps) {
  const [busy, setBusy] = useState<"activate" | "pause" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [preflight, setPreflight] = useState<PreflightWarning[] | null>(null);

  async function callLifecycle(
    action: "activate" | "pause" | "resume",
    acknowledge = false,
  ) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/${action}`), {
        method: "POST",
        ...(action === "activate"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ acknowledge_warnings: acknowledge }),
            }
          : {}),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        warnings?: PreflightWarning[];
      };
      if (action === "activate" && res.status === 409 && Array.isArray(json.warnings)) {
        setPreflight(json.warnings);
        setBusy(null);
        return;
      }
      if (!res.ok) {
        throw new Error(json.error || `${action} failed (${res.status})`);
      }
      setPreflight(null);
      onChanged();
      if (action === "activate") {
        toast.success(`Activated "${campaignName}"`, {
          description: "Sending starts on the next cron tick during the send window.",
        });
      } else if (action === "pause") {
        toast.success(`Paused "${campaignName}"`);
      } else if (action === "resume") {
        toast.success(`Resumed "${campaignName}"`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const isLocalChannel =
    sourceChannel === "native_email" || sourceChannel === "linkedin";
  const canActivate = status === "draft" && isLocalChannel;
  const canPause = status === "active";
  const canResume = status === "paused";

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
          {canActivate && (
            <DropdownMenuItem
              onClick={() => callLifecycle("activate")}
              disabled={busy !== null}
            >
              {busy === "activate" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Rocket size={14} />
              )}
              Activate
            </DropdownMenuItem>
          )}
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
          {(canActivate || canPause || canResume) && <DropdownMenuSeparator />}
          <DropdownMenuItem
            onClick={() => setDeleteOpen(true)}
            disabled={busy !== null}
            className="text-red-600 focus:text-red-700 data-highlighted:bg-red-50"
          >
            <Trash2 size={14} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {error && (
        <p className="absolute right-4 mt-1 text-[11px] text-red-600">{error}</p>
      )}

      <DeleteCampaignDialog
        campaignId={campaignId}
        campaignName={campaignName}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={onChanged}
      />

      <ActivatePreflightDialog
        campaignName={campaignName}
        open={preflight !== null}
        warnings={preflight ?? []}
        busy={busy === "activate"}
        onOpenChange={(o) => {
          if (!o) setPreflight(null);
        }}
        onConfirm={() => callLifecycle("activate", true)}
      />
    </>
  );
}
