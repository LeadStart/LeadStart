"use client";

// A/B test results — one table per A/B email node, variants ranked with the
// leader (highest positive-reply rate) flagged. Once the auto-winner reaches a
// verdict it locks a Winner and marks the losers Paused; until then it shows the
// current front-runner as Leading. Measured on inbound outcomes only (reply /
// positive-reply rate), never opens/clicks.

import { Trophy, Pause } from "lucide-react";
import type { AbNodeStats } from "@/lib/flow/variants";

export function AbResults({ stats }: { stats: AbNodeStats[] }) {
  if (!stats.length) return null;
  return (
    <div className="space-y-3">
      {stats.map((node) => {
        const pausedCount = node.variants.filter((v) => v.paused).length;
        return (
          <div key={node.nodeId} className="rounded-xl border border-border/60 p-4">
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-sm font-semibold text-foreground">A/B test</span>
              <span className="text-xs text-muted-foreground">
                {node.firstEmail ? "first email" : "follow-up"} ·{" "}
                {node.decided
                  ? "winner locked — losers auto-paused"
                  : node.autoPause
                    ? "auto-winner on — leader by positive-reply rate"
                    : "leader by positive-reply rate (auto-pause off)"}
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
                    const winner = v.id === node.winnerId;
                    const leading = !node.decided && v.id === node.leaderId;
                    return (
                      <tr
                        key={v.id}
                        className={
                          winner ? "bg-emerald-50/70" : v.paused ? "opacity-55" : ""
                        }
                      >
                        <td className="py-1.5 pr-3 font-semibold">
                          <span className="inline-flex items-center gap-1.5">
                            {winner && <Trophy size={12} className="text-emerald-600" />}
                            {v.paused && <Pause size={11} className="text-amber-600" />}
                            {v.label}
                            {winner && (
                              <span className="rounded bg-emerald-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                                Winner
                              </span>
                            )}
                            {leading && (
                              <span className="rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                Leading
                              </span>
                            )}
                            {v.paused && (
                              <span className="rounded bg-amber-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                                Paused
                              </span>
                            )}
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
                            winner ? "font-bold text-emerald-700" : ""
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
              {node.decided ? (
                <>
                  Test decided — new leads now route to the winner. {pausedCount} losing
                  variant{pausedCount === 1 ? "" : "s"} paused; leads already in a paused
                  variant’s thread stay on it.
                </>
              ) : node.autoPause ? (
                <>
                  Even split, sticky per lead. Auto-winner is on: once there’s a decisive
                  winner (95% significance + a ≥1&nbsp;pt lead on positive-reply rate) the
                  losing variants pause automatically.
                </>
              ) : (
                <>
                  Even split, sticky per lead. Auto-winner is off — pick a winner yourself, or
                  enable auto-pause on this step or in campaign settings.
                </>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}
