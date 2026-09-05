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
  UserSearch,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { EnrichmentAddons, EnrichmentRun, EnrichmentWaterfallMethod } from "@/types/app";
import {
  ENRICH_POLL_INTERVAL_MS,
  type EnrichmentRunDetail,
} from "@/components/contacts/enrichment-run-banner";

// The live enrichment pipeline shown on the right of the Prospecting panel.
// Direction A (vertical actor rail) with Direction B's radial for the overall.
// It draws from two real sources: the LinkedIn SEARCH (sourcing stage) and, once
// contacts are imported, the org's active ENRICHMENT RUN (the four Apify actor
// phases). Verification is the final stage: it runs at first send, so it shows
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

// The 2nd-pass waterfall fans out by company size: each band routes to its own
// method. We only have the config snapshot (no per-band counts), so the rail shows
// the routing PLAN, not fake per-method progress.
type RouterBand = { label: string; method: EnrichmentWaterfallMethod };
type RouterView = { bands: RouterBand[] };

// Short method labels for the compact rail. Canonical long labels live in the
// waterfall settings card (waterfall-settings-card.tsx METHOD_OPTIONS).
const METHOD_SHORT: Record<EnrichmentWaterfallMethod, string> = {
  pattern_mv: "pattern + verify",
  scrape_plus_pattern: "scrape → pattern",
  site_scrape: "site scrape",
  bovi: "bovi",
  off: "off",
};

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
  subNote?: string; // secondary line (e.g. domains phase also grabs phone + size)
  router?: RouterView; // size-routing map, waterfall stage only
  counted: boolean; // whether it feeds the overall radial
};

const PHASE_ORDER: Record<string, number> = {
  profiles: 0,
  domains: 1,
  naming: 2,
  waterfall: 3,
  activity: 4,
  verify: 5,
};

// Core stages (always shown) + the two opt-in add-ons (activity, verify). The
// add-ons are filtered out of the rail unless enabled: see the assembly below.
const ENRICH_DEFS = [
  { key: "profiles", name: "Profile → email", actor: "profile-scraper", icon: Mail, color: "#3b46ff", unit: "emails", addon: false, found: (r: EnrichmentRun) => r.found_emails_profiles_count },
  { key: "domains", name: "Company → domain", actor: "linkedin-company", icon: Globe, color: "#6366f1", unit: "domains", addon: false, found: (r: EnrichmentRun) => r.found_domains_count },
  { key: "naming", name: "Owner name", actor: "decision-maker", icon: UserSearch, color: "#f59e0b", unit: "names", addon: true, found: (r: EnrichmentRun) => r.found_names_count },
  { key: "waterfall", name: "2nd-pass email", actor: "pattern + verify", icon: Layers, color: "#8b5cf6", unit: "recovered", addon: false, found: (r: EnrichmentRun) => r.found_emails_waterfall_count },
  { key: "activity", name: "Activity", actor: "profile-posts", icon: Activity, color: "#6366f1", unit: "active", addon: true, found: (r: EnrichmentRun) => r.found_activity_count },
  { key: "verify", name: "Verify", actor: "Million Verifier", icon: ShieldCheck, color: "#10b981", unit: "verified", addon: true, found: (r: EnrichmentRun) => r.found_verified_count },
] as const;

export function PipelineStatusPanel({
  search,
  starting,
  enrichmentRunId,
  addons,
  autoRun,
}: {
  search: SearchStatusLite;
  starting: boolean;
  enrichmentRunId: string | null;
  // The opt-in add-ons chosen for this search (activity / verify). Drives which
  // add-on stages show in the rail BEFORE a run exists; once a run exists the
  // run's own flags take over. Null = neither (not yet chosen / legacy).
  addons: EnrichmentAddons | null;
  // Whether the org auto-runs enrichment after a search (kill-switch). Only
  // changes the "sourced" caption copy.
  autoRun: boolean;
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
        // transient: reschedule
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
    if (searchActive) {
      const proc = search?.result_count ?? 0;
      const total = search?.target_max_results ?? 0;
      return {
        ...base,
        state: "active",
        // Starting placeholder == the early-progress floor (0.05), so the bar is
        // monotonic: it never drops from a high "starting" guess down to the real
        // first-result value (which used to read as 2% → 1%).
        frac: proc > 0 && total > 0 ? Math.min(0.95, Math.max(0.05, proc / total)) : 0.05,
        processed: proc > 0 ? proc : undefined,
        total: proc > 0 && total > 0 ? total : undefined,
        note: search?.progress_message ?? "Searching LinkedIn…",
      };
    }
    return { ...base, state: "idle", frac: 0 };
  })();

  // ---- enrichment stages ----
  // Activity + verify are opt-in add-ons: shown only when the run enabled them or
  // this search intends them (so a queued add-on appears before the run exists).
  const showActivity = (run?.run_activity ?? false) || (addons?.activity ?? false);
  const showVerify = (run?.run_verify ?? false) || (addons?.verify ?? false);
  const showNaming = (run?.run_naming ?? false) || (addons?.naming ?? false);
  const defs = ENRICH_DEFS.filter((d) => {
    if (d.key === "activity") return showActivity;
    if (d.key === "verify") return showVerify;
    if (d.key === "naming") return showNaming;
    return true;
  });

  const cur = run ? PHASE_ORDER[run.phase] ?? 0 : -1;
  const enrichStages: StageView[] = defs.map((d) => {
    const base = { key: d.key, name: d.name, actor: d.actor, icon: d.icon, color: d.color, unit: d.unit, counted: true };
    if (d.key === "activity" && run && run.run_activity === false)
      return { ...base, state: "skipped", frac: 1, note: "skipped, already gated on activity" };
    if (d.key === "verify" && run && run.run_verify === false)
      return { ...base, state: "skipped", frac: 1, note: "verification off for this run" };
    if (d.key === "naming" && run && run.run_naming === false)
      return { ...base, state: "skipped", frac: 1, note: "owner-name lookup off for this run" };
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

  // Surface the two things the new flow added: the domains phase also captures a
  // company phone + employee count, and the 2nd-pass waterfall routes by that size.
  const wf = run?.waterfall_config ?? null;
  for (const s of enrichStages) {
    if (s.key === "domains") {
      // When discovery is on, the domains step is two-stage: the LinkedIn company
      // lookup plus a web lookup for companies with no LinkedIn page.
      if (wf?.domain_discovery_enabled) s.actor = "linkedin-company + web lookup";
      if (s.state === "active" || s.state === "done") {
        s.subNote = "+ company phone & size captured";
      }
    }
    if (s.key === "waterfall" && s.state !== "skipped") {
      if (run && run.run_waterfall === false) {
        s.state = "skipped";
        s.frac = 1;
        s.note = "waterfall disabled in settings";
      } else if (wf) {
        const bands: RouterBand[] = [
          { label: `≤ ${wf.size_threshold} emp`, method: wf.small_method },
          { label: `> ${wf.size_threshold} emp`, method: wf.large_method },
          { label: "unknown size", method: wf.unknown_method },
        ];
        const uniqueMethods = Array.from(new Set(bands.map((b) => b.method)));
        // Collapse to the single method when every band agrees; else it's routed.
        s.actor = uniqueMethods.length === 1 ? METHOD_SHORT[uniqueMethods[0]] : "size-routed";
        // Only worth drawing the branch when the bands actually differ.
        if (uniqueMethods.length > 1) s.router = { bands };
      }
    }
  }

  const stages = [sourcing, ...enrichStages];

  // ---- overall (radial) ----
  const counted = stages.filter((s) => s.counted);
  const rawOverall = counted.reduce((a, s) => a + (s.state === "skipped" ? 1 : s.frac), 0) / counted.length;
  // Only read a full 100% once the run has actually completed. A fully-processed
  // but not-yet-advanced active phase (e.g. activity 20/20 while the worker
  // finalizes the tick) has frac=1 and would otherwise show 100% with a stage
  // still spinning: cap it at 99% until the run is complete.
  const runComplete = run?.status === "complete";
  const overall = runComplete ? rawOverall : Math.min(rawOverall, 0.99);
  const pct = runComplete ? 100 : Math.min(99, Math.round(rawOverall * 100));

  const centerNote = (() => {
    if (search?.status === "failed" || run?.status === "failed") return "attention needed";
    if (run?.status === "complete") return "enrichment complete";
    const active = stages.find((s) => s.state === "active");
    if (active) return active.name.toLowerCase();
    if (searchDone && !run) return autoRun ? "sourced · starting enrichment…" : "sourced · import to enrich";
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
        {stage.subNote && !dim && (
          <p className="mt-1 text-[10px] text-muted-foreground">{stage.subNote}</p>
        )}
        {stage.router && (
          <div className="mt-1.5 rounded-md border border-[#2E37FE]/15 bg-[#2E37FE]/[0.035] px-2 py-1.5">
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[#1C24B8]/70">
              Routed by company size
            </p>
            <div className="space-y-0.5">
              {stage.router.bands.map((b) => (
                <div key={b.label} className="flex items-center justify-between gap-2 text-[10.5px]">
                  <span className="text-muted-foreground">{b.label}</span>
                  <span className="flex items-center gap-1">
                    <span className="text-[#2E37FE]/50">→</span>
                    <span
                      className={`font-mono text-[10px] ${
                        b.method === "off" ? "text-muted-foreground/60" : "font-medium text-[#1C24B8]"
                      }`}
                    >
                      {METHOD_SHORT[b.method]}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
