"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, XCircle, X } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { EnrichmentRun, EnrichmentRunItem } from "@/types/app";

export const ENRICH_POLL_INTERVAL_MS = 3000;

export interface EnrichmentRunDetail {
  run: EnrichmentRun;
  items: EnrichmentRunItem[];
}

// Fetch the org's active (pending/running) enrichment run id, or null. The
// contacts page calls this on mount to resume the banner after a refresh.
export async function fetchActiveEnrichmentRunId(): Promise<string | null> {
  try {
    const res = await fetch(appUrl("/api/admin/contacts/enrich/runs"), { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { active: { id: string } | null };
    return data.active?.id ?? null;
  } catch {
    return null;
  }
}

function phaseLine(run: EnrichmentRun): string {
  if (run.status === "pending") return "Queued: waiting for the worker";
  if (run.status === "complete") return "Enrichment complete";
  if (run.status === "failed") return `Enrichment failed: ${run.error_message ?? "unknown error"}`;
  const n = run.processed_count;
  const N = run.phase_total_count;
  switch (run.phase) {
    case "profiles":
      return `Finding emails from LinkedIn profiles (HarvestAPI) · ${n}/${N}`;
    case "domains":
      return `Resolving company domains · ${n}/${N}`;
    case "naming":
      return `Finding owner names (decision-maker) · ${n}/${N}`;
    case "waterfall":
      return `Second pass on misses · ${n}/${N}`;
    case "activity":
      return `Scoring LinkedIn activity · ${n}/${N}`;
    case "verify":
      return `Verifying emails (Million Verifier) · ${n}/${N}`;
    default:
      return "Working…";
  }
}

export function EnrichmentRunBanner({
  runId,
  onDone,
  onDismiss,
}: {
  runId: string | null;
  onDone?: (run: EnrichmentRun) => void | Promise<void>;
  onDismiss?: () => void;
}): React.JSX.Element | null {
  const [detail, setDetail] = useState<EnrichmentRunDetail | null>(null);
  const doneFiredRef = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    setDetail(null);
    doneFiredRef.current = null;
    if (!runId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(appUrl(`/api/admin/contacts/enrich/run/${runId}`), { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as EnrichmentRunDetail;
          if (cancelled) return;
          setDetail(data);
          const status = data.run.status;
          if (status === "complete" || status === "failed") {
            if (doneFiredRef.current !== runId) {
              doneFiredRef.current = runId;
              void onDoneRef.current?.(data.run);
            }
            return; // stop polling: terminal
          }
        }
      } catch {
        // transient: fall through to reschedule
      }
      if (!cancelled) timer = setTimeout(poll, ENRICH_POLL_INTERVAL_MS);
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  if (!runId || !detail) return null;
  const { run } = detail;
  const terminal = run.status === "complete" || run.status === "failed";

  const tone =
    run.status === "failed"
      ? "border-red-200 bg-red-50 text-red-800"
      : run.status === "complete"
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : "border-blue-200 bg-blue-50 text-blue-800";

  const cost = Number(run.cost_usd || 0);
  const foundEmails = run.found_emails_profiles_count + run.found_emails_waterfall_count;
  const noEmail = Math.max(0, run.total_count - foundEmails);

  return (
    <div className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 ${tone}`}>
      <div className="flex items-start gap-2">
        {run.status === "failed" ? (
          <XCircle size={16} className="mt-0.5 shrink-0 text-red-500" />
        ) : run.status === "complete" ? (
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-500" />
        ) : (
          <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin" />
        )}
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{phaseLine(run)}</p>
          <p className="text-[11px] opacity-80">
            Emails found {run.found_emails_profiles_count}
            {run.run_waterfall ? ` (+${run.found_emails_waterfall_count} second pass)` : ""} · Domains{" "}
            {run.found_domains_count}/{run.total_count}
            {run.run_naming ? ` · Names ${run.found_names_count}` : ""}
            {run.run_activity ? ` · Active ${run.found_activity_count}` : ""}
            {run.run_verify ? ` · Verified ${run.found_verified_count}` : ""} · est. cost $
            {cost.toFixed(3)}
            {run.progress_message ? ` · ${run.progress_message}` : ""}
          </p>
          {run.status === "complete" && noEmail > 0 && (
            <p className="text-[11px] font-medium">
              {foundEmails} got an email · {noEmail} have none: filter &ldquo;Needs enrichment&rdquo; below to route them to a LinkedIn campaign or park them.
            </p>
          )}
        </div>
      </div>
      {terminal && onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
