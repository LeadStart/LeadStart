"use client";

// Per-campaign Million Verifier send-gate control for the Deliverability tab
// (migrations 00129 + 00130). A three-way choice, stored as two booleans:
//   every send      -> verify_before_send=true,  verify_first_send_only=false
//   first send only -> verify_before_send=true,  verify_first_send_only=true
//   off             -> verify_before_send=false, verify_first_send_only=false
//
// Immediate-save (its own PATCH, like CampaignTagFollow): optimistic switch,
// revert + error on failure. It does NOT join the workspace "Save changes" batch.

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck, Loader2, AlertTriangle } from "lucide-react";
import { appUrl } from "@/lib/api-url";

type Mode = "all" | "first" | "off";

function toMode(verifyBeforeSend: boolean, firstOnly: boolean): Mode {
  if (!verifyBeforeSend) return "off";
  return firstOnly ? "first" : "all";
}

const PAYLOAD: Record<Mode, { verify_before_send: boolean; verify_first_send_only: boolean }> = {
  all: { verify_before_send: true, verify_first_send_only: false },
  first: { verify_before_send: true, verify_first_send_only: true },
  off: { verify_before_send: false, verify_first_send_only: false },
};

const OPTIONS: { value: Mode; title: string; desc: string }[] = [
  {
    value: "all",
    title: "Verify every send",
    desc: "Check each recipient before every send. Invalid and disposable addresses are skipped, catch-all/unknown ones send flagged risky, and if the verifier is unavailable the send holds. Fresh results (≤30 days) are reused, so most follow-ups cost nothing.",
  },
  {
    value: "first",
    title: "Verify first send only",
    desc: "Check the first email to each contact; follow-ups send without re-verifying. Keeps credit spend to one check per contact and never holds a lead mid-sequence over a re-check.",
  },
  {
    value: "off",
    title: "Don’t verify",
    desc: "Send without the pre-send check.",
  },
];

export function DeliverabilityGateCard({
  campaignId,
  initialVerifyBeforeSend,
  initialVerifyFirstSendOnly,
}: {
  campaignId: string;
  initialVerifyBeforeSend: boolean;
  initialVerifyFirstSendOnly: boolean;
}) {
  const [mode, setMode] = useState<Mode>(toMode(initialVerifyBeforeSend, initialVerifyFirstSendOnly));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: Mode) {
    if (busy || next === mode) return;
    const prev = mode;
    setBusy(true);
    setError(null);
    setMode(next); // optimistic
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/deliverability`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(PAYLOAD[next]),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't update the setting.");
    } catch (err) {
      setMode(prev); // revert
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-start gap-2 pb-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#7c3aed]">
          <ShieldCheck size={16} className="text-white" />
        </div>
        <div className="flex-1">
          <CardTitle className="flex items-center gap-2 text-base">
            Pre-send email verification
            {busy && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose when this campaign checks a recipient with Million Verifier before sending.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2" role="radiogroup" aria-label="Pre-send verification">
          {OPTIONS.map((opt) => {
            const active = mode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                onClick={() => choose(opt.value)}
                className={`w-full rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed ${
                  active
                    ? "border-[#2E37FE] bg-[#2E37FE]/5 ring-1 ring-[#2E37FE]/30"
                    : "border-border/60 hover:border-border"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      active ? "border-[#2E37FE]" : "border-muted-foreground/40"
                    }`}
                  >
                    {active && <span className="h-2 w-2 rounded-full bg-[#2E37FE]" />}
                  </span>
                  <span className="text-sm font-semibold text-[#0f172a]">{opt.title}</span>
                </span>
                <span className="mt-1 block pl-6 text-[11px] leading-relaxed text-muted-foreground">
                  {opt.desc}
                </span>
              </button>
            );
          })}
        </div>

        {mode === "off" && (
          <p className="inline-flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              This campaign&apos;s emails send with no pre-send check. Only turn verification off for
              a list you&apos;ve already verified — sending to bad addresses drives bounces and hurts
              domain reputation.
            </span>
          </p>
        )}

        <p className="text-[11px] text-muted-foreground">
          Verification only runs while a Million Verifier key is configured in
          Settings&nbsp;→&nbsp;API.
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </CardContent>
    </Card>
  );
}
