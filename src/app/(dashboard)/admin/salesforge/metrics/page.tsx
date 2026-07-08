"use client";

// /admin/salesforge/metrics — workspace-wide rollup of Salesforge
// sequence performance. Pulls from the SDK's /sequence-metrics
// endpoint, which sums across every sequence in the workspace.

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, BarChart3, AlertCircle } from "lucide-react";
import { appUrl } from "@/lib/api-url";

interface Metrics {
  contacted?: number;
  opened?: number;
  openedPercent?: number;
  clicked?: number;
  clickedPercent?: number;
  replied?: number;
  repliedPercent?: number;
  repliedPositive?: number;
  repliedPositivePercent?: number;
  bounced?: number;
  bouncedPercent?: number;
}

function MetricCard({
  label,
  value,
  pct,
  color,
}: {
  label: string;
  value: number | undefined;
  pct?: number;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 p-5 bg-card">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1" style={{ color }}>
        {(value ?? 0).toLocaleString()}
      </p>
      {pct !== undefined && (
        <p className="text-xs text-muted-foreground mt-1">{pct.toFixed(1)}%</p>
      )}
    </div>
  );
}

export default function SalesforgeMetricsPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(appUrl("/api/admin/salesforge/sequence-metrics"));
        const data = await res.json();
        if (!active) return;
        if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
        setMetrics(data.metrics ?? {});
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[12px] p-5 sm:p-7" style={{ background: "#EDEEFF", border: "1px solid #e2e8f0" }}>
        <p className="text-xs font-medium text-[#64748b]">Salesforge</p>
        <h1 className="text-[20px] sm:text-[22px] font-bold mt-1">Workspace metrics</h1>
        <p className="text-sm text-[#0f172a]/60 mt-1">
          Aggregate performance across every active Salesforge sequence
          in the workspace. For per-campaign metrics, open the campaign
          detail page.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 size={16} /> Rollup
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Loader2 size={20} className="inline animate-spin mr-2" />
              Loading…
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
              <MetricCard label="Contacted" value={metrics?.contacted} color="#2E37FE" />
              <MetricCard label="Opened" value={metrics?.opened} pct={metrics?.openedPercent} color="#2E37FE" />
              <MetricCard label="Clicked" value={metrics?.clicked} pct={metrics?.clickedPercent} color="#0EA5E9" />
              <MetricCard label="Replied" value={metrics?.replied} pct={metrics?.repliedPercent} color="#10b981" />
              <MetricCard label="Positive replies" value={metrics?.repliedPositive} pct={metrics?.repliedPositivePercent} color="#059669" />
              <MetricCard label="Bounced" value={metrics?.bounced} pct={metrics?.bouncedPercent} color="#dc2626" />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
