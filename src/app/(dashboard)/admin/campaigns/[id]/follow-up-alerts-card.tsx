"use client";

// The campaign's follow-up alerts (campaigns.follow_up_alerts, migration 00142),
// on the Setup tab beside the saved reply. Daniel, 2026-11-09: "ANY follow-up
// response thereafter needs to give us a notification if we choose so for
// certain campaigns." On = every message a lead sends after their first reply
// pushes to the phones signed up for alerts and emails the owner logins,
// whatever it says (src/lib/replies/follow-up.ts).
//
// Immediate-save like the Deliverability tab's choices: optimistic, reverted
// with a toast on failure. Nothing in the card appears or goes with the choice,
// so it keeps its size.

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BellRing, Loader2 } from "lucide-react";
import { appUrl } from "@/lib/api-url";

const OPTIONS: { value: boolean; title: string; desc: string }[] = [
  {
    value: false,
    title: "Hot replies only",
    desc: "You're alerted when a reply reads as interested, a meeting or a question. Anything else a lead sends waits in the Inbox.",
  },
  {
    value: true,
    title: "Every follow-up",
    desc: "Once a lead has replied, everything else they send pushes to your phone and emails you, whatever it says, out-of-office replies included.",
  },
];

export function FollowUpAlertsCard({ campaignId, initial }: { campaignId: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function choose(next: boolean) {
    if (busy || next === on) return;
    setBusy(true);
    setOn(next); // optimistic
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/follow-up-alerts`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ follow_up_alerts: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't update follow-up alerts.");
    } catch (err) {
      setOn(!next); // revert
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-2 pb-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary">
          <BellRing size={16} className="text-white" />
        </div>
        <div className="flex-1">
          <CardTitle className="flex items-center gap-2 text-base">
            Follow-up alerts
            {busy && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose what tells you when a lead from this campaign writes again.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2" role="radiogroup" aria-label="Follow-up alerts">
          {OPTIONS.map((opt) => {
            const active = on === opt.value;
            return (
              <button
                key={String(opt.value)}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                onClick={() => choose(opt.value)}
                className={`w-full rounded-lg border p-3 text-left transition-colors cursor-pointer disabled:cursor-not-allowed ${
                  active
                    ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                    : "border-border-soft hover:border-border"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      active ? "border-primary" : "border-muted-foreground/40"
                    }`}
                  >
                    {active && <span className="h-2 w-2 rounded-full bg-primary" />}
                  </span>
                  <span className="text-sm font-semibold text-foreground">{opt.title}</span>
                </span>
                <span className="mt-1 block pl-6 text-[11px] leading-relaxed text-muted-foreground">
                  {opt.desc}
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
