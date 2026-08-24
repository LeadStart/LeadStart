"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Search,
  Mail,
  Globe,
  Layers,
  Activity,
  ShieldCheck,
  Check,
  Loader2,
  XCircle,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { EnrichmentRun } from "@/types/app";
import {
  ENRICH_POLL_INTERVAL_MS,
  type EnrichmentRunDetail,
} from "@/components/contacts/enrichment-run-banner";

// The live enrichment pipeline shown on the right of the Prospecting panel.
// Direction A (vertical actor rail) with Direction B's radial for the overall.
// It draws from two real sources: the LinkedIn SEARCH (sourcing stage) and, once
// contacts are imported, the org's active ENRICHMENT RUN (the four Apify actor
// phases). Verification is the final stage — it runs at first send, so it shows
// as an informational step here, never live.

// What the panel needs from the parent's search detail (kept loose so the
// parent's SearchDetail type stays private).
export type SearchStatusLite = {
  status: string;
  result_count: number;
  target_max_results: number;
  cost_usd: number | string;
  progress_message: string | null;
  error_message: string | null;
} | null;

type StageState = "idle" | "queued" | "active" | "done" | "skipped" | "failed";

type StageView = {
  key: string;
  name: string;
  actor: string;
  icon: LucideIcon;
  color: string;
  state: StageState;
  frac: number; // 0..1 progress for this stage
  processed?: number;
  total?: number;
  result?: number;
  unit?: string;
  note?: string;
  counted: boolean; // whether it feeds the overall radial
};

const PHASE_ORDER: Record<string, number> = {
  profiles: 0,
  domains: 1,
  waterfall: 2,
  activity: 3,
};

const ENRICH_DEFS = [
  { key: "profiles", name: "Profile → email", actor: "profile-scraper", icon: Mail, color: "#3b46ff", unit: "emails", found: (r: EnrichmentRun) => r.found_emails_profiles_count },
  { key: "domains", name: "Company → domain", actor: "linkedin-company", icon: Globe, color: "#6366f1", unit: "domains", found: (r: EnrichmentRun) => r.found_domains_count },
  { key: "waterfall", name: "2nd-pass email", actor: "vdrmota", icon: Layers, color: "#8b5cf6", unit: "recovered", found: (r: EnrichmentRun) => r.found_emails_waterfall_count },
  { key: "activity", name: "Activity", actor: "profile-posts", icon: Activity, color: "#6366f1", unit: "active", found: (r: EnrichmentRun) => r.found_activity_count },
] as const;

export function PipelineStatusPanel({
  search,
  starting,
  enrichmentRunId,
}: {
  search: SearchStatusLite;
  starting: boolean;
  enrichmentRunId: string | null;
}) {
  const [run, setRun] = useState<EnrichmentRun | null>(null);

  // Poll the enrichment run (reuses the same endpoint the Contacts banner uses).
  useEffect(() => {
    setRun(null);
    if (!enrichmentRunId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await fetch(appUrl(`/api/admin/contacts/enrich/run/${enrichmentRunId}`), {
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as EnrichmentRunDetail;
          if (cancelled) return;
          setRun(data.run);
          if (data.run.status === "complete" || data.run.status === "failed") return;
        }
      } catch {
        // transient — reschedule
      }
      if (!cancelled) timer = setTimeout(poll, ENRICH_POLL_INTERVAL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enrichmentRunId]);

  const searchDone = search?.status === "complete";
  const searchActive = starting || search?.status === "pending" || search?.status === "running";

  // ---- sourcing stage ----
  const sourcing: StageView = (() => {
    const base = { key: "search", name: "Profile search", actor: "profile-search", icon: Search, color: "#2E37FE", counted: true };
    if (search?.status === "failed")
      return { ...base, state: "failed", frac: 0, note: search.error_message ?? "Search failed" };
    if (searchDone)
      return { ...base, state: "done", frac: 1, processed: search!.result_count, total: search!.result_count, result: search!.result_count, unit: "sourced" };
    if (searchActive)
      return { ...base, state: "active", frac: 0.2, note: search?.progress_message ?? "Searching LinkedIn…" };
    return { ...base, state: "idle", frac: 0 };
  })();

  // ---- enrichment stages ----
  const cur = run ? PHASE_ORDER[run.phase] ?? 0 : -1;
  const enrichStages: StageView[] = ENRICH_DEFS.map((d) => {
    const base = { key: d.key, name: d.name, actor: d.actor, icon: d.icon, color: d.color, unit: d.unit, counted: true };
    if (d.key === "activity" && run && run.run_activity === false)
      return { ...base, state: "skipped", frac: 1, note: "skipped — already gated on activity" };
    if (!run)
      return { ...base, state: searchDone ? "queued" : "idle", frac: 0 };
    if (run.status === "complete")
      return { ...base, state: "done", frac: 1, processed: run.total_count, total: run.total_count, result: d.found(run) };
    const idx = PHASE_ORDER[d.key];
    if (run.status === "failed")
      return idx < cur
        ? { ...base, state: "done", frac: 1, result: d.found(run), processed: run.total_count, total: run.total_count }
        : idx === cur
          ? { ...base, state: "failed", frac: 0, note: run.error_message ?? "Enrichment failed" }
          : { ...base, state: "idle", frac: 0 };
    if (idx < cur)
      return { ...base, state: "done", frac: 1, result: d.found(run), processed: run.total_count, total: run.total_count };
    if (idx === cur)
      return {
        ...base,
        state: "active",
        frac: run.phase_total_count ? run.processed_count / run.phase_total_count : 0,
        processed: run.processed_count,
        total: run.phase_total_count,
        result: d.found(run),
      };
    return { ...base, state: "queued", frac: 0 };
  });

  const verify: StageView = {
    key: "verify",
    name: "Verify",
    actor: "Million Verifier",
    icon: ShieldCheck,
    color: "#10b981",
    state: run?.status === "complete" ? "queued" : "idle",
    frac: 0,
    note: "runs at first send",
    counted: false,
  };

  const stages = [sourcing, ...enrichStages, verify];

  // ---- overall (radial) ----
  const counted = stages.filter((s) => s.counted);
  const overall = counted.reduce((a, s) => a + (s.state === "skipped" ? 1 : s.frac), 0) / counted.length;
  const pct = Math.round(overall * 100);

  const centerNote = (() => {
    if (search?.status === "failed" || run?.status === "failed") return "attention needed";
    if (run?.status === "complete") return "enrichment complete";
    const active = stages.find((s) => s.state === "active");
    if (active) return active.name.toLowerCase();
    if (searchDone && !run) return "sourced · import to enrich";
    if (searchActive) return "sourcing";
    return "ready";
  })();

  const totalCost =
    (search ? Number(search.cost_usd) || 0 : 0) + (run ? Number(run.cost_usd) || 0 : 0);
  const anyActivity = searchActive || (run && run.status !== "complete" && run.status !== "failed");
  const idle = !search && !starting && !run;

  // radial geometry
  const R = 42;
  const CIRC = 2 * Math.PI * R;
  const offset = CIRC * (1 - overall);

  return (
    <div className="flex h-full flex-col rounded-xl border border-border/60 bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
            anyActivity ? "bg-[#EDEEFF] text-[#1C24B8]" : "bg-muted text-muted-foreground"
          }`}
        >
          {anyActivity ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#2E37FE]" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
          )}
          {anyActivity ? "Live" : "Idle"}
        </span>
        <span className="text-sm font-semibold">Enrichment pipeline</span>
      </div>

      {/* radial */}
      <div className="mt-3 flex items-center gap-4">
        <div className="relative h-[104px] w-[104px] shrink-0">
          <svg width="104" height="104" viewBox="0 0 96 96" className="-rotate-90">
            <circle cx="48" cy="48" r={R} fill="none" stroke="#eef1f7" strokeWidth="9" />
            <circle
              cx="48"
              cy="48"
              r={R}
              fill="none"
              stroke="url(#pipeGrad)"
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={offset}
              style={{ transition: "stroke-dashoffset .35s ease" }}
            />
            <defs>
              <linearGradient id="pipeGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#2E37FE" />
                <stop offset="1" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[22px] font-bold leading-none tracking-tight tabular-nums">{pct}%</span>
            <span className="mt-0.5 max-w-[86px] text-center text-[9.5px] leading-tight text-muted-foreground">
              {centerNote}
            </span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-muted-foreground">
            {idle
              ? "Run a search and each Apify actor will process your contacts here."
              : "Contacts move left-to-right through the actor stages."}
          </p>
          {!idle && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Spend so far{" "}
              <span className="font-mono font-medium tabular-nums text-foreground">${totalCost.toFixed(2)}</span>
            </p>
          )}
        </div>
      </div>

      {/* rail */}
      <div className="mt-3 flex flex-col">
        {stages.map((s, i) => (
          <StageRow key={s.key} stage={s} last={i === stages.length - 1} />
        ))}
      </div>
    </div>
  );
}

function StageRow({ stage, last }: { stage: StageView; last: boolean }) {
  const Icon = stage.icon;
  const done = stage.state === "done" || stage.state === "skipped";
  const active = stage.state === "active";
  const failed = stage.state === "failed";
  const dim = stage.state === "idle" || stage.state === "queued";

  return (
    <div className="relative grid grid-cols-[26px_1fr] gap-2.5 py-[7px]">
      {/* node + connector */}
      <div className="relative flex justify-center">
        <span
          className={`z-10 flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 bg-card ${
            failed
              ? "border-red-400 text-red-500"
              : done
                ? "border-[#2E37FE] bg-[#2E37FE] text-white"
                : active
                  ? "border-[#2E37FE] text-[#2E37FE] shadow-[0_0_0_4px_rgba(46,55,254,0.12)]"
                  : "border-border text-muted-foreground"
          }`}
        >
          {failed ? (
            <XCircle size={13} />
          ) : done ? (
            <Check size={13} />
          ) : active ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Icon size={13} />
          )}
        </span>
        {!last && (
          <span
            className={`absolute top-[26px] h-[calc(100%-18px)] w-0.5 ${done ? "bg-[#2E37FE]" : "bg-border"}`}
          />
        )}
      </div>
      {/* body */}
      <div className={`min-w-0 ${dim ? "opacity-60" : ""}`}>
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <span className="text-[12.5px] font-semibold">{stage.name}</span>{" "}
            <span className="font-mono text-[10px] text-muted-foreground">{stage.actor}</span>
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {stage.state === "active" && stage.total != null
              ? `${stage.processed ?? 0} / ${stage.total}`
              : stage.state === "done" && stage.processed != null
                ? `${stage.processed} / ${stage.total}`
                : ""}
          </span>
        </div>
        {(stage.state === "active" || stage.state === "done") && (
          <div className="mt-1.5 h-[6px] overflow-hidden rounded-full bg-[#eef1f7]">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.round(stage.frac * 100)}%`, background: stage.color, transition: "width .25s linear" }}
            />
          </div>
        )}
        {stage.result != null && stage.result > 0 && (
          <p className="mt-1 text-[10.5px] font-semibold text-emerald-600">
            ✓ {stage.result} {stage.unit}
          </p>
        )}
        {stage.note && (
          <p className={`mt-1 text-[10.5px] ${failed ? "text-red-600" : "text-muted-foreground"}`}>{stage.note}</p>
        )}
      </div>
    </div>
  );
}
