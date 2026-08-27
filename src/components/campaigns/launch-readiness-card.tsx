// Launch-readiness panel for a draft native campaign: the checklist of what's
// still needed before it can send (hard blockers, red) plus soft notes (amber).
// Presentational — the readiness is computed server-side and the same rule gates
// the Launch button + the activate endpoint. Rendered only for drafts.

import { Rocket, AlertCircle, CircleCheck } from "lucide-react";
import type { LaunchReadiness } from "@/lib/campaigns/launch-readiness";

export function LaunchReadinessCard({ readiness }: { readiness: LaunchReadiness }) {
  const { canLaunch, blockers, warnings } = readiness;

  if (canLaunch && warnings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
        <CircleCheck size={16} className="shrink-0" /> Ready to launch — everything a send needs
        is in place.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Rocket size={15} className="text-[#2E37FE]" />
        {canLaunch ? "Ready to launch" : "Before you can launch"}
      </div>
      {blockers.length > 0 && (
        <ul className="mt-2.5 space-y-1.5">
          {blockers.map((b) => (
            <li key={b.key} className="flex items-center gap-2 text-sm text-red-700">
              <AlertCircle size={14} className="shrink-0" />
              {b.label}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className={`space-y-1 ${blockers.length > 0 ? "mt-2 border-t border-border/40 pt-2" : "mt-2.5"}`}>
          {warnings.map((w) => (
            <li key={w.key} className="flex items-center gap-2 text-xs text-amber-700">
              <AlertCircle size={12} className="shrink-0" />
              {w.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
