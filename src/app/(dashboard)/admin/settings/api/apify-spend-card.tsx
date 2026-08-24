"use client";

// Apify spend — the AUTHORITATIVE per-cycle cost, read live from Apify (not our
// per-run tallies, which drift on retries/aborts/deletes). Shows the cycle
// total against the plan cap and a per-actor breakdown that INCLUDES failed and
// aborted runs — so an aborted vdrmota waterfall shows up here instead of
// vanishing. This should match the Apify invoice.

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Receipt, RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import { appUrl } from "@/lib/api-url";

type ActorSpend = {
  actorId: string;
  name: string;
  usd: number;
  runs: number;
  notSucceeded: number;
};
type Spend = {
  cycleStart: string | null;
  cycleEnd: string | null;
  usageUsd: number | null;
  limitUsd: number | null;
  runsTotalUsd: number;
  runsCounted: number;
  truncated: boolean;
  byActor: ActorSpend[];
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ApifySpendCard() {
  const [data, setData] = useState<Spend | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(appUrl("/api/admin/apify/spend"), { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? `Failed to load spend (${res.status})`);
        return;
      }
      setData(d as Spend);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load spend");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const total = data?.usageUsd ?? data?.runsTotalUsd ?? 0;
  const cap = data?.limitUsd ?? null;
  const pct = cap && cap > 0 ? Math.min(100, Math.round((total / cap) * 100)) : null;
  const over = cap != null && total >= cap;
  const near = pct != null && pct >= 80;
  const barColor = over ? "#dc2626" : near ? "#d97706" : "#059669";

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-700">
          <Receipt size={16} className="text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <CardTitle className="text-base">Apify spend</CardTitle>
          <p className="text-xs text-muted-foreground">
            Actual charges from Apify this billing cycle — includes failed &amp; aborted runs. Matches
            your Apify invoice.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="shrink-0 gap-1.5">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
            <span>{error}</span>
          </div>
        ) : !data && loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> Reading your Apify usage…
          </div>
        ) : data ? (
          <>
            {/* headline: total vs cap */}
            <div>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold tabular-nums" style={{ color: over ? "#dc2626" : "#0f172a" }}>
                      ${total.toFixed(2)}
                    </span>
                    {cap != null && (
                      <span className="text-sm text-muted-foreground">
                        of ${cap.toFixed(2)} cap{pct != null ? ` · ${pct}%` : ""}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Cycle {fmtDate(data.cycleStart)} – {fmtDate(data.cycleEnd)} · {data.runsCounted} run
                    {data.runsCounted === 1 ? "" : "s"}
                  </p>
                </div>
                {over && (
                  <span className="rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 border border-red-200">
                    Cap reached — new runs 403
                  </span>
                )}
              </div>
              {pct != null && (
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: barColor }} />
                </div>
              )}
            </div>

            {/* per-actor breakdown */}
            {data.byActor.length === 0 ? (
              <p className="text-sm text-muted-foreground">No actor runs charged this cycle yet.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border/60">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 text-left font-semibold">Actor</th>
                      <th className="px-3 py-2 text-right font-semibold">Runs</th>
                      <th className="px-3 py-2 text-right font-semibold">Charged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byActor.map((a) => (
                      <tr key={a.actorId} className="border-t border-border/50">
                        <td className="px-3 py-2">
                          <span className="font-mono text-[12px]">{a.name}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {a.runs}
                          {a.notSucceeded > 0 && (
                            <span className="ml-1 text-[11px] text-red-600">({a.notSucceeded} failed)</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-medium tabular-nums">
                          ${a.usd.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-border bg-muted/30">
                      <td className="px-3 py-2 text-[12px] font-semibold">Actor-run total</td>
                      <td></td>
                      <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">
                        ${data.runsTotalUsd.toFixed(2)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              {data.usageUsd != null &&
                Math.abs(data.usageUsd - data.runsTotalUsd) > 0.01 && (
                  <>
                    The headline (${total.toFixed(2)}) is Apify&apos;s account total for the cycle; the
                    breakdown (${data.runsTotalUsd.toFixed(2)}) covers actor-run charges only (small gaps
                    are storage / platform usage).{" "}
                  </>
                )}
              {data.truncated && "Showing the most recent 1,000 runs. "}
              Figures come straight from Apify, so an aborted or failed run still appears here.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
