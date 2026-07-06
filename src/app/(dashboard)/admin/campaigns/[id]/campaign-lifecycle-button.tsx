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

type Status = "active" | "paused" | "draft" | "completed" | null;

export function CampaignLifecycleButton({
  campaignId,
  campaignName,
  status,
  sourceChannel,
}: {
  campaignId: string;
  campaignName: string;
  status: Status;
  sourceChannel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

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

  async function run() {
    setBusy(true);
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/${action}`), {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || `${action} failed (${res.status})`);
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

  const label = action === "activate" ? "Activate campaign" : action === "pause" ? "Pause" : "Resume";
  const Icon = action === "activate" ? Rocket : action === "pause" ? Pause : Play;

  return (
    <Button
      onClick={run}
      disabled={busy}
      size="sm"
      variant={action === "activate" ? undefined : "outline"}
      className="gap-1.5 shrink-0"
      style={action === "activate" ? { background: "#16a34a", color: "white" } : undefined}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
      {label}
    </Button>
  );
}
