"use client";

// Prominent one-click lifecycle control on the campaign detail page. Shows the
// action that applies to the current status: Activate (draft → active, local
// channels only), Pause (active), or Resume (paused). Hits the same lifecycle
// endpoints as the campaigns-list ⋯ menu, then refreshes the page.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Rocket, Pause, Play, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { appUrl } from "@/lib/api-url";
import { ActivatePreflightDialog } from "@/components/campaigns/activate-preflight-dialog";
import type { PreflightWarning } from "@/lib/deliverability/preflight";
import type { ReadinessItem } from "@/lib/campaigns/launch-readiness";

type Status = "active" | "paused" | "draft" | "completed" | null;

export function CampaignLifecycleButton({
  campaignId,
  campaignName,
  status,
  sourceChannel,
  blockers = [],
}: {
  campaignId: string;
  campaignName: string;
  status: Status;
  sourceChannel: string;
  // Hard launch blockers (native email). When present, the Launch button is
  // disabled — the same rule the activate endpoint enforces server-side.
  blockers?: ReadinessItem[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [preflight, setPreflight] = useState<PreflightWarning[] | null>(null);

  const isLocal = sourceChannel === "native_email" || sourceChannel === "linkedin";
  const action: "activate" | "pause" | "resume" | null =
    status === "draft" && isLocal
      ? "activate"
      : status === "active"
        ? "pause"
        : status === "paused"
          ? "resume"
          : null;
  if (!action) return null;

  // acknowledge = true re-submits past the pre-flight warnings.
  async function run(acknowledge = false) {
    setBusy(true);
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
      if (res.status === 409 && Array.isArray(json.warnings)) {
        setPreflight(json.warnings); // open the dialog; keep busy off
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error(json.error || `${action} failed (${res.status})`);
      setPreflight(null);
      if (action === "activate") {
        toast.success(`Activated "${campaignName}"`, {
          description: "Sending starts on the next cron tick inside the send window.",
        });
      } else if (action === "pause") {
        toast.success(`Paused "${campaignName}"`);
      } else {
        toast.success(`Resumed "${campaignName}"`);
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const label =
    action === "activate" ? "Launch campaign" : action === "pause" ? "Pause campaign" : "Resume campaign";
  const Icon = action === "activate" ? Rocket : action === "pause" ? Pause : Play;
  // Disable Launch while hard blockers remain (the readiness card lists them).
  const notReady = action === "activate" && blockers.length > 0;

  return (
    <>
      <Button
        onClick={() => run(false)}
        disabled={busy || notReady}
        variant={action === "activate" ? undefined : "outline"}
        className="gap-1.5 shrink-0"
        style={
          action === "activate" && !notReady ? { background: "#16a34a", color: "white" } : undefined
        }
        title={notReady ? `Not ready to launch: ${blockers.map((b) => b.label).join("; ")}` : undefined}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
        {label}
      </Button>
      <ActivatePreflightDialog
        campaignName={campaignName}
        open={preflight !== null}
        warnings={preflight ?? []}
        busy={busy}
        onOpenChange={(o) => {
          if (!o) setPreflight(null);
        }}
        onConfirm={() => run(true)}
      />
    </>
  );
}
