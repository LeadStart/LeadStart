"use client";

import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { ADMIN_CAMPAIGNS_KEY, fetchAdminCampaigns } from "@/lib/admin-queries";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Mail, ArrowRight } from "lucide-react";
import { useSort } from "@/hooks/use-sort";
import { SortableHead } from "@/components/ui/sortable-head";

export default function AllCampaignsPage() {
  const { data, loading } = useSupabaseQuery(
    ADMIN_CAMPAIGNS_KEY,
    fetchAdminCampaigns,
  );

  const { campaigns, clients, snapshots } = data || { campaigns: [], clients: [], snapshots: [] };
  const clientMap = new Map(clients.map((c) => [c.id, c]));
  const active = campaigns.filter((c) => c.status === "active").length;
  const paused = campaigns.filter((c) => c.status === "paused").length;

  const rows = campaigns.map((campaign) => {
    const client = clientMap.get(campaign.client_id);
    const metrics = calculateMetrics(snapshots.filter((s) => s.campaign_id === campaign.id));
    return { ...campaign, clientName: client?.name || "", metrics };
  });
  const { sorted, sortConfig, requestSort } = useSort(rows, "name", "asc");

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="rounded-xl h-64 bg-muted/50" /></div>;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Campaign Management</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>All Campaigns</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">{active} active &middot; {paused} paused &middot; {campaigns.length} total</p>
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
                  return (
                    <TableRow key={row.id} className="group">
                      <TableCell><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0" style={{ background: '#2E37FE' }}><Mail size={14} /></div><Link href={`/admin/clients/${row.client_id}/campaigns/${row.id}`} className="font-medium text-foreground hover:text-[#2E37FE] transition-colors">{row.name}</Link></div></TableCell>
                      <TableCell><Link href={`/admin/clients/${row.client_id}`} className="text-muted-foreground hover:text-foreground transition-colors">{row.clientName || "—"}</Link></TableCell>
                      <TableCell><Badge variant="secondary" className={row.status === "active" ? "badge-green" : row.status === "paused" ? "badge-amber" : "badge-slate"}>{row.status}</Badge></TableCell>
                      <TableCell className="text-right font-medium">{row.metrics.emails_sent.toLocaleString()}</TableCell>
                      <TableCell className="text-right"><span className={row.metrics.reply_rate >= 5 ? "text-emerald-600 font-medium" : "text-amber-600"}>{row.metrics.reply_rate}%</span></TableCell>
                      <TableCell className="text-right"><span className={row.metrics.bounce_rate <= 2 ? "text-emerald-600" : "text-red-600 font-medium"}>{row.metrics.bounce_rate}%</span></TableCell>
                      <TableCell className="text-right font-medium">{row.metrics.meetings_booked}</TableCell>
                      <TableCell><Link href={`/admin/clients/${row.client_id}/campaigns/${row.id}`}><ArrowRight size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" /></Link></TableCell>
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
