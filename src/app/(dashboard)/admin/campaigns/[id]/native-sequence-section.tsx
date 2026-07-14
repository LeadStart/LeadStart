"use client";

// Composes the Sequence & schedule card with the deliverability pre-flight.
// The deliverability check state lives here so its trigger can sit in the
// sequence card header (next to Edit) while the results render in the
// DeliverabilityCard below — which only mounts once a check has started.

import { useState } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appUrl } from "@/lib/api-url";
import type { SendWindowConfig } from "@/lib/gmail/ramp";
import { NativeSequenceCard, type StepDraft } from "./native-sequence-card";
import { DeliverabilityCard, type DeliverabilityResult } from "./deliverability-card";

export function NativeSequenceSection({
  campaignId,
  initialSteps,
  initialWindow,
  initialNewLeadsCap,
}: {
  campaignId: string;
  initialSteps: StepDraft[];
  initialWindow: SendWindowConfig;
  initialNewLeadsCap: number;
}) {
  const [result, setResult] = useState<DeliverabilityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runCheck() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/deliverability`));
      const data = (await res.json()) as DeliverabilityResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Check failed.");
        return;
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const hasRun = loading || result !== null || error !== null;

  return (
    <>
      <NativeSequenceCard
        campaignId={campaignId}
        initialSteps={initialSteps}
        initialWindow={initialWindow}
        initialNewLeadsCap={initialNewLeadsCap}
        headerActions={
          <Button
            variant="outline"
            size="sm"
            onClick={runCheck}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            {result ? "Re-run check" : "Run check"}
          </Button>
        }
      />
      {hasRun && <DeliverabilityCard result={result} loading={loading} error={error} />}
    </>
  );
}
