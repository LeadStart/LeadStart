"use client";

// /admin/salesforge/bulk — multi-select pause/resume across Salesforge
// campaigns. Loads only source_channel='salesforge' campaigns from the
// local DB; bulk action posts to the bulk-status endpoint which
// updates Salesforge + the local row in one round-trip per campaign.

import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Pause, Play, AlertCircle, CheckCircle } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { useUser } from "@/hooks/use-user";

interface Campaign {
  id: string;
  name: string;
  status: string;
  salesforge_sequence_id: string | null;
  client_id: string | null;
}

export default function BulkOpsPage() {
  const { organizationId } = useUser();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<{ succeeded: number; failed: number } | null>(null);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    (async () => {
      const supabase = createClient();
      try {
        const { data, error: dbError } = await supabase
          .from("campaigns")
          .select("id, name, status, salesforge_sequence_id, client_id")
          .eq("organization_id", organizationId)
          .eq("source_channel", "salesforge")
          .order("name");
        if (!active) return;
        if (dbError) throw new Error(dbError.message);
        setCampaigns((data ?? []) as Campaign[]);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [organizationId]);

  const allSelected = useMemo(
    () => campaigns.length > 0 && selected.size === campaigns.length,
    [campaigns, selected],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(campaigns.map((c) => c.id)));
  }

  async function bulkAction(status: "active" | "paused") {
    if (selected.size === 0) return;
    setSubmitting(true);
    setLastResult(null);
    setError(null);
    try {
      const res = await fetch(appUrl("/api/admin/salesforge/sequences/bulk-status"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_ids: Array.from(selected),
          status,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Bulk action failed (${res.status})`);
      setLastResult({
        succeeded: (data.succeeded ?? []).length,
        failed: (data.failed ?? []).length,
      });
      // Refresh statuses locally.
      setCampaigns((prev) =>
        prev.map((c) =>
          (data.succeeded ?? []).includes(c.id) ? { ...c, status } : c,
        ),
      );
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7" style={{ background: "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)", border: "1px solid rgba(46,55,254,0.2)" }}>
        <p className="text-xs font-medium text-[#64748b]">Salesforge</p>
        <h1 className="text-[20px] sm:text-[22px] font-bold mt-1">Bulk pause / resume</h1>
        <p className="text-sm text-[#0f172a]/60 mt-1">
          Multi-select Salesforge campaigns and pause or resume them
          all at once. Useful for holiday breaks or mass-pausing during
          an issue.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}
      {lastResult && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <CheckCircle size={16} className="text-emerald-500 mt-0.5" />
          <p className="text-sm text-emerald-700">
            {lastResult.succeeded} succeeded, {lastResult.failed} failed.
          </p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Salesforge campaigns ({campaigns.length})
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => bulkAction("paused")}
              disabled={submitting || selected.size === 0}
            >
              {submitting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Pause size={14} className="mr-1" />}
              Pause selected ({selected.size})
            </Button>
            <Button
              size="sm"
              onClick={() => bulkAction("active")}
              disabled={submitting || selected.size === 0}
              style={{ background: "#2E37FE" }}
            >
              {submitting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Play size={14} className="mr-1" />}
              Resume selected ({selected.size})
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Loader2 size={20} className="inline animate-spin mr-2" /> Loading…
            </div>
          ) : campaigns.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No Salesforge campaigns yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sequence ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id} className={selected.has(c.id) ? "bg-[#2E37FE]/5" : ""}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggle(c.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>
                      <Badge className={
                        c.status === "active" ? "badge-green" :
                        c.status === "paused" ? "badge-amber" :
                        "bg-gray-100 text-gray-500"
                      }>
                        {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {c.salesforge_sequence_id ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
