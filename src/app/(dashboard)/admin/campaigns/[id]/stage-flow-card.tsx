// Admin-only "Contacts by sending stage" panel for the native-email campaign
// detail page. A vertical waterfall of the sequence: one row per step showing
// how many active contacts are waiting there right now (and how many have been
// sent that step so far), topped by an explicit projected-completion banner and
// closed by a terminal band (replied / completed / failed). Pure presentational
// server component — all counts + the projection are computed in page.tsx and
// passed in. The red step badges deliberately mirror the Sequence & schedule
// card directly below it so the owner reads flow and copy together.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Activity,
  CalendarCheck,
  Clock,
  CornerDownRight,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import type { CompletionProjection } from "@/lib/gmail/ramp";

// Brand ramp — deepens as contacts progress toward the finish.
const STEP_COLORS = ["#A3A8FF", "#6B72FF", "#2E37FE", "#1C24B8"];
function stepColor(i: number): string {
  return STEP_COLORS[Math.min(i, STEP_COLORS.length - 1)];
}

export interface StageRow {
  index: number; // 0-based step index
  subject: string; // resolved display subject (Re: fallback already applied)
  cadence: string; // "Sends immediately" / "Waits 3 days after the previous step"
  waiting: number; // active enrollments whose next step is this one
  sent: number; // native_sends logged for this step so far
}

export function StageFlowCard({
  stages,
  terminal,
  totals,
  projection,
}: {
  stages: StageRow[];
  terminal: { replied: number; completed: number; failed: number };
  totals: { active: number; enrolled: number; sent: number };
  projection: CompletionProjection;
}) {
  const maxWaiting = Math.max(1, ...stages.map((s) => s.waiting));

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EA4335]">
          <Activity size={16} className="text-white" />
        </div>
        <div>
          <CardTitle className="text-base">Contacts by sending stage</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Where every enrolled contact sits in the sequence right now —{" "}
            <span className="font-medium text-foreground">
              {totals.active.toLocaleString()}
            </span>{" "}
            active of {totals.enrolled.toLocaleString()} enrolled.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <CompletionBanner projection={projection} />

        <div>
          {/* Timeline — connector line runs behind the step badges */}
          <div className="relative">
            {stages.length > 1 && (
              <div
                className="absolute left-4 top-3 bottom-6 w-0.5 -translate-x-1/2"
                style={{ background: "linear-gradient(180deg,#A3A8FF,#1C24B8)" }}
                aria-hidden
              />
            )}
            <ol className="space-y-0">
              {stages.map((s) => {
                const barPct = Math.max(3, (s.waiting / maxWaiting) * 100);
                const isLast = s.index === stages.length - 1;
                return (
                  <li key={s.index} className="relative flex gap-4 pb-4">
                    <span
                      className="relative z-[1] flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
                      style={{ background: "#EA4335", boxShadow: "0 3px 8px rgba(234,67,53,0.35)" }}
                    >
                      {s.index + 1}
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className="truncate text-sm font-semibold text-[#0f172a]">
                        {s.subject}
                        {isLast && (
                          <span className="ml-1 text-xs font-medium text-muted-foreground">
                            · last step
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock size={12} /> {s.cadence}
                      </p>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#eef1f6]">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${barPct}%`, background: stepColor(s.index) }}
                        />
                      </div>
                    </div>
                    <div className="w-[130px] shrink-0 pt-0.5 text-right">
                      <p
                        className="text-[22px] font-bold leading-none text-[#0f172a]"
                        style={{ fontVariantNumeric: "tabular-nums" }}
                      >
                        {s.waiting.toLocaleString()}{" "}
                        <span className="text-[11px] font-medium text-muted-foreground">
                          here now
                        </span>
                      </p>
                      <p className="mt-1 text-[11.5px] text-muted-foreground">
                        {s.sent.toLocaleString()} sent so far
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* Terminal band — contacts that have left the sequence */}
          <div className="ml-12 mt-1 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Left the sequence
            </span>
            <TermBadge tone="green" icon={<CornerDownRight size={12} />} label="Replied" value={terminal.replied} />
            <TermBadge tone="blue" icon={<CheckCircle2 size={12} />} label="Completed" value={terminal.completed} />
            <TermBadge tone="red" icon={<XCircle size={12} />} label="Failed" value={terminal.failed} />
            <span className="ml-auto text-[11.5px] text-muted-foreground">
              {totals.sent.toLocaleString()} emails sent to date
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CompletionBanner({ projection }: { projection: CompletionProjection }) {
  const isProjected = projection.status === "projected";
  const headline =
    projection.status === "projected"
      ? `~ ${projection.dateLabel}`
      : projection.status === "paused"
        ? "New leads paused"
        : projection.status === "done"
          ? "Sequence complete"
          : "Not enough data yet";

  return (
    <div
      className="relative flex flex-wrap items-center gap-4 overflow-hidden rounded-2xl px-5 py-4 text-white"
      style={{
        background: "linear-gradient(135deg,#2E37FE 0%,#1C24B8 60%,#0F1880 100%)",
        boxShadow: "0 8px 22px rgba(28,36,184,0.30)",
      }}
    >
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
        style={{ background: "rgba(255,255,255,0.16)" }}
      >
        <CalendarCheck size={22} />
      </div>
      <div className="min-w-0">
        <p
          className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: "rgba(255,255,255,0.75)" }}
        >
          Projected sequence completion
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] tracking-normal"
            style={{ background: "rgba(255,255,255,0.2)" }}
          >
            estimate
          </span>
        </p>
        <p className={`${isProjected ? "text-[22px]" : "text-lg"} font-bold leading-tight`}>
          {headline}
        </p>
        <p className="mt-0.5 max-w-[560px] text-xs" style={{ color: "rgba(255,255,255,0.82)" }}>
          {projection.driver}
        </p>
      </div>
      {isProjected && projection.weeks != null && (
        <div className="ml-auto text-right">
          <p className="text-[26px] font-bold leading-none">
            ≈ {projection.weeks} {projection.weeks === 1 ? "week" : "weeks"}
          </p>
          <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.75)" }}>
            at current pace
          </p>
        </div>
      )}
    </div>
  );
}

function TermBadge({
  tone,
  icon,
  label,
  value,
}: {
  tone: "green" | "blue" | "red";
  icon: ReactNode;
  label: string;
  value: number;
}) {
  // A zero doesn't shout — muted slate until there's something to report.
  const gradients: Record<typeof tone, string> = {
    green: "linear-gradient(135deg,#10B981,#047857)",
    blue: "linear-gradient(135deg,#6B72FF,#1C24B8)",
    red: "linear-gradient(135deg,#ef4444,#b91c1c)",
  };
  const shadows: Record<typeof tone, string> = {
    green: "0 3px 10px rgba(4,120,87,0.32)",
    blue: "0 3px 10px rgba(46,55,254,0.32)",
    red: "0 3px 10px rgba(185,28,28,0.32)",
  };
  const active = value > 0;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
      style={
        active
          ? { background: gradients[tone], color: "#fff", boxShadow: shadows[tone] }
          : { background: "#e2e8f0", color: "#475569" }
      }
    >
      {icon} {label} {value.toLocaleString()}
    </span>
  );
}
