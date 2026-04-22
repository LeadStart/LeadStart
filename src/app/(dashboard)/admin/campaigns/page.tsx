"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { ADMIN_CAMPAIGNS_KEY, fetchAdminCampaigns } from "@/lib/admin-queries";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Mail, ArrowRight, RefreshCcw } from "lucide-react";
import { useSort } from "@/hooks/use-sort";
import { SortableHead } from "@/components/ui/sortable-head";

export default function AllCampaignsPage() {
  const { data, loading, refetch } = useSupabaseQuery(
    ADMIN_CAMPAIGNS_KEY,
    fetchAdminCampaigns,
  );

  const { campaigns, clients, snapshots } = data || { campaigns: [], clients: [], snapshots: [] };
  const clientMap = new Map(clients.map((c) => [c.id, c]));
  const active = campaigns.filter((c) => c.status === "active").length;
  const paused = campaigns.filter((c) => c.status === "paused").length;
  const unlinked = campaigns.filter((c) => c.client_id === null).length;

  const rows = campaigns.map((campaign) => {
    const client = campaign.client_id ? clientMap.get(campaign.client_id) : undefined;
    const metrics = calculateMetrics(snapshots.filter((s) => s.campaign_id === campaign.id));
    return { ...campaign, clientName: client?.name || "", metrics };
  });
  const { sorted, sortConfig, requestSort } = useSort(rows, "name", "asc");

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="rounded-xl h-64 bg-muted/50" /></div>;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-[#64748b]">Campaign Management</p>
            <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>All Campaigns</h1>
            <p className="text-sm text-[#0f172a]/60 mt-1">
              {active} active &middot; {paused} paused &middot; {campaigns.length} total
              {unlinked > 0 && (
                <>
                  {" "}
                  &middot;{" "}
                  <Link
                    href="/admin/campaigns/unlinked"
                    className="text-amber-700 font-medium hover:underline"
                  >
                    {unlinked} unlinked
                  </Link>
                </>
              )}
            </p>
          </div>
          <SyncFromInstantlyButton onDone={refetch} />
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent className="pt-6">
          {campaigns.length === 0 ? <p className="text-sm text-muted-foreground">No campaigns yet.</p> : (
            <Table>
              <TableHeader><TableRow><SortableHead sortKey="name" sortConfig={sortConfig} onSort={requestSort}>Campaign</SortableHead><SortableHead sortKey="clientName" sortConfig={sortConfig} onSort={requestSort}>Client</SortableHead><SortableHead sortKey="status" sortConfig={sortConfig} onSort={requestSort}>Status</SortableHead><SortableHead sortKey="metrics.emails_sent" sortConfig={sortConfig} onSort={requestSort} className="text-right">Sent (30d)</SortableHead><SortableHead sortKey="metrics.reply_rate" sortConfig={sortConfig} onSort={requestSort} className="text-right">Reply Rate</SortableHead><SortableHead sortKey="metrics.bounce_rate" sortConfig={sortConfig} onSort={requestSort} className="text-right">Bounce Rate</SortableHead><SortableHead sortKey="metrics.meetings_booked" sortConfig={sortConfig} onSort={requestSort} className="text-right">Positive</SortableHead><TableHead></TableHead></TableRow></TableHeader>
              <TableBody>
                {sorted.map((row) => {
                  const isOrphan = row.client_id === null;
                  const campaignHref = isOrphan ? null : `/admin/clients/${row.client_id}/campaigns/${row.id}`;
                  const clientHref = isOrphan ? null : `/admin/clients/${row.client_id}`;
                  return (
                    <TableRow key={row.id} className="group">
                      <TableCell><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0" style={{ background: '#2E37FE' }}><Mail size={14} /></div>{campaignHref ? <Link href={campaignHref} className="font-medium text-foreground hover:text-[#2E37FE] transition-colors">{row.name}</Link> : <span className="font-medium text-foreground">{row.name}</span>}</div></TableCell>
                      <TableCell>{clientHref ? <Link href={clientHref} className="text-muted-foreground hover:text-foreground transition-colors">{row.clientName || "—"}</Link> : <Badge variant="secondary" className="badge-amber">Unlinked</Badge>}</TableCell>
                      <TableCell><Badge variant="secondary" className={row.status === "active" ? "badge-green" : row.status === "paused" ? "badge-amber" : "badge-slate"}>{row.status}</Badge></TableCell>
                      <TableCell className="text-right font-medium">{row.metrics.emails_sent.toLocaleString()}</TableCell>
                      <TableCell className="text-right"><span className={row.metrics.reply_rate >= 5 ? "text-emerald-600 font-medium" : "text-amber-600"}>{row.metrics.reply_rate}%</span></TableCell>
                      <TableCell className="text-right"><span className={row.metrics.bounce_rate <= 2 ? "text-emerald-600" : "text-red-600 font-medium"}>{row.metrics.bounce_rate}%</span></TableCell>
                      <TableCell className="text-right font-medium">{row.metrics.meetings_booked}</TableCell>
                      <TableCell>{campaignHref && <Link href={campaignHref}><ArrowRight size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" /></Link>}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SyncFromInstantlyButton({ onDone }: { onDone: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleClick() {
    setSyncing(true);
    setResult(null);
    setIsError(false);
    try {
      const res = await fetch("/api/admin/sync-campaigns", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Sync failed (${res.status})`);
      setResult(`+${json.created} new · ${json.updated} updated · ${json.orphan_count} unlinked`);
      onDone();
    } catch (err) {
      setIsError(true);
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={handleClick} disabled={syncing} className="gap-2">
        <RefreshCcw size={14} className={syncing ? "animate-spin" : ""} />
        {syncing ? "Syncing…" : "Sync from Instantly"}
      </Button>
      {result && (
        <p className={`text-xs ${isError ? "text-red-600" : "text-muted-foreground"}`}>{result}</p>
      )}
    </div>
  );
}
