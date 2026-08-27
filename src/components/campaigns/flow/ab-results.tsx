"use client";

// A/B test results — one table per A/B email node, variants ranked with the
// leader (highest positive-reply rate, ≥1 positive) flagged. Measured on
// inbound outcomes only (reply / positive-reply rate), never opens/clicks.

import { Trophy } from "lucide-react";
import type { AbNodeStats } from "@/lib/flow/variants";

export function AbResults({ stats }: { stats: AbNodeStats[] }) {
  if (!stats.length) return null;
  return (
    <div className="space-y-3">
      {stats.map((node) => (
        <div key={node.nodeId} className="rounded-xl border border-border/60 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold text-foreground">A/B test</span>
            <span className="text-xs text-muted-foreground">
              {node.firstEmail ? "first email" : "follow-up"} · winner by positive-reply rate
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Variant</th>
                  <th className="py-1 pr-3 font-medium">Subject</th>
                  <th className="py-1 pr-3 text-right font-medium">Sent</th>
                  <th className="py-1 pr-3 text-right font-medium">Reply</th>
                  <th className="py-1 pr-3 text-right font-medium">Positive</th>
                </tr>
              </thead>
              <tbody>
                {node.variants.map((v) => {
                  const leader = v.id === node.leaderId;
                  return (
                    <tr key={v.id} className={leader ? "bg-emerald-50/70" : ""}>
                      <td className="py-1.5 pr-3 font-semibold">
                        <span className="inline-flex items-center gap-1">
                          {leader && <Trophy size={12} className="text-emerald-600" />}
                          {v.label}
                        </span>
                      </td>
                      <td className="max-w-[220px] truncate py-1.5 pr-3 text-muted-foreground">
                        {v.subject.trim() || <span className="italic">threads as “Re:”</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{v.sent}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {v.replyRatePct}% <span className="text-muted-foreground">({v.replied})</span>
                      </td>
                      <td
                        className={`py-1.5 pr-3 text-right tabular-nums ${
                          leader ? "font-bold text-emerald-700" : ""
                        }`}
                      >
                        {v.positiveRatePct}% <span className="text-muted-foreground">({v.positive})</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Even split, sticky per lead. Rates need volume to be meaningful — let each variant gather sends before calling it.
          </p>
        </div>
      ))}
    </div>
  );
}
