"use client";

import { useEffect, useState } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { ADMIN_CAMPAIGNS_KEY, fetchAdminCampaigns } from "@/lib/admin-queries";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { calculateMetrics } from "@/lib/kpi/calculator";
import {
  filterSnapshotsByPeriod,
  DEFAULT_METRICS_PERIOD,
  type MetricsPeriod,
} from "@/lib/kpi/period";
import { PeriodToggle } from "@/components/kpi/period-toggle";
import { Mail, ArrowRight, Plus, RefreshCw } from "lucide-react";
import { useSort } from "@/hooks/use-sort";
import { SortableHead } from "@/components/ui/sortable-head";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { CampaignRowActions } from "./campaign-row-actions";
import { appUrl } from "@/lib/api-url";
import { toast } from "sonner";

const CAMPAIGNS_PAGE_SIZE = 10;

export default function AllCampaignsPage() {
  const { data, loading, refetch } = useSupabaseQuery(
    ADMIN_CAMPAIGNS_KEY,
    fetchAdminCampaigns,
  );

  const { campaigns, clients, snapshots } = data || { campaigns: [], clients: [], snapshots: [] };
  const clientMap = new Map(clients.map((c) => [c.id, c]));

  // KPI time-window lens. Defaults to All-Time — a rolling 30-day reply rate
  // understated it (fresh, unreplied leads dilute the denominator). 7d/30d
  // filter the all-time snapshot pull client-side (no refetch on switch).
  const [period, setPeriod] = useState<MetricsPeriod>(DEFAULT_METRICS_PERIOD);
  // Render-stable clock so the period filter stays pure (react-hooks/purity).
  const [now] = useState(() => Date.now());

  const rows = campaigns.map((campaign) => {
    const client = campaign.client_id ? clientMap.get(campaign.client_id) : undefined;
    const metrics = calculateMetrics(
      filterSnapshotsByPeriod(
        snapshots.filter((s) => s.campaign_id === campaign.id),
        period,
        now,
      ),
    );
    return { ...campaign, clientName: client?.name || "", metrics };
  });
  const { sorted, sortConfig, requestSort } = useSort(rows, "name", "asc");
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [sortConfig?.key, sortConfig?.direction, period]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / CAMPAIGNS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * CAMPAIGNS_PAGE_SIZE;
  const pageRows = sorted.slice(pageStart, pageStart + CAMPAIGNS_PAGE_SIZE);

  const [syncingInstantly, setSyncingInstantly] = useState(false);
  async function handleSyncInstantly() {
    setSyncingInstantly(true);
    try {
      const res = await fetch(appUrl("/api/admin/instantly/sync-campaigns"), {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Sync failed (${res.status})`);
      toast.success(
        json.synced > 0
          ? `Synced ${json.synced} Instantly campaign${json.synced === 1 ? "" : "s"}`
          : "No Instantly campaigns found",
        json.synced > 0
          ? { description: "New ones show as “Unlinked” — open each to link a client." }
          : undefined,
      );
      refetch();
    } catch (err) {
      toast.error("Couldn't sync Instantly campaigns", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSyncingInstantly(false);
    }
  }

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="rounded-xl h-64 bg-muted/50" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="All Campaigns"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link href="/admin/campaigns/new/native">
              <Button size="sm" className="gap-2">
                <Plus size={14} /> New email campaign
              </Button>
            </Link>
            <Link href="/admin/campaigns/new/linkedin">
              <Button size="sm" variant="outline" className="gap-2">
                <Plus size={14} /> New LinkedIn campaign
              </Button>
            </Link>
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={handleSyncInstantly}
              disabled={syncingInstantly}
            >
              <RefreshCw
                size={14}
                className={syncingInstantly ? "animate-spin" : ""}
              />
              {syncingInstantly ? "Syncing…" : "Sync Instantly"}
            </Button>
          </div>
        }
      />
      <Card className="border-border/50 shadow-sm">
        <CardContent className="pt-6">
          {campaigns.length === 0 ? <p className="text-sm text-muted-foreground">No campaigns yet.</p> : (
            <>
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">
                Reply &amp; bounce rates reflect{" "}
                {period === "all"
                  ? "all-time"
                  : `the last ${period === "7d" ? "7" : "30"} days`}
              </p>
              <PeriodToggle period={period} onChange={setPeriod} />
            </div>
            {/* Mobile: stacked cards — no sideways-scrolling table */}
            <div className="space-y-2.5 lg:hidden">
              {pageRows.map((row) => {
                const isOrphan = row.client_id === null;
                const campaignHref = `/admin/campaigns/${row.id}`;
                const clientHref = isOrphan ? null : `/admin/clients/${row.client_id}`;
                return (
                  <div key={row.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg text-white shrink-0" style={{ background: "#2E37FE" }}><Mail size={15} /></div>
                      <div className="min-w-0 flex-1">
                        <Link href={campaignHref} className="block font-medium text-foreground truncate hover:text-[#2E37FE]">{row.name}</Link>
                        <div className="text-xs text-muted-foreground truncate">
                          {clientHref ? <Link href={clientHref} className="hover:text-foreground">{row.clientName || "—"}</Link> : <span className="text-amber-600">Unlinked</span>}
                        </div>
                      </div>
                      <Badge variant="secondary" className={`shrink-0 ${row.status === "active" ? "badge-green" : row.status === "paused" ? "badge-amber" : "badge-slate"}`}>{row.status}</Badge>
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2 border-t border-border/60 pt-3">
                      <div className="min-w-0"><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Sent</p><p className="text-sm font-semibold tabular-nums truncate">{row.metrics.emails_sent.toLocaleString()}</p></div>
                      <div className="min-w-0"><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Reply</p><p className={`text-sm font-semibold tabular-nums ${row.metrics.reply_rate >= 5 ? "text-emerald-600" : row.metrics.reply_rate >= 2 ? "text-amber-600" : "text-red-600"}`}>{row.metrics.reply_rate}%</p></div>
                      <div className="min-w-0"><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Bounce</p><p className={`text-sm font-semibold tabular-nums ${row.metrics.bounce_rate <= 2 ? "text-emerald-600" : "text-red-600"}`}>{row.metrics.bounce_rate}%</p></div>
                      <div className="min-w-0"><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Positive</p><p className="text-sm font-semibold tabular-nums">{row.metrics.meetings_booked}</p></div>
                    </div>
                    <div className="mt-3 flex items-center gap-1 border-t border-border/60 pt-3">
                      <CampaignRowActions campaignId={row.id} campaignName={row.name} status={row.status as "active" | "paused" | "draft" | "completed" | null} sourceChannel={row.source_channel} onChanged={refetch} />
                      <Link href={campaignHref} className="ml-auto flex items-center gap-1 text-sm font-medium text-[#2E37FE]">View <ArrowRight size={13} /></Link>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Desktop: full sortable table */}
            <div className="hidden lg:block">
            <Table>
              <TableHeader><TableRow><SortableHead sortKey="name" sortConfig={sortConfig} onSort={requestSort}>Campaign</SortableHead><SortableHead sortKey="clientName" sortConfig={sortConfig} onSort={requestSort}>Client</SortableHead><SortableHead sortKey="status" sortConfig={sortConfig} onSort={requestSort}>Status</SortableHead><SortableHead sortKey="metrics.emails_sent" sortConfig={sortConfig} onSort={requestSort} className="text-right">Sent{period === "7d" ? " (7d)" : period === "30d" ? " (30d)" : ""}</SortableHead><SortableHead sortKey="metrics.reply_rate" sortConfig={sortConfig} onSort={requestSort} className="text-right">Reply Rate</SortableHead><SortableHead sortKey="metrics.bounce_rate" sortConfig={sortConfig} onSort={requestSort} className="text-right">Bounce Rate</SortableHead><SortableHead sortKey="metrics.meetings_booked" sortConfig={sortConfig} onSort={requestSort} className="text-right">Positive</SortableHead><TableHead></TableHead></TableRow></TableHeader>
              <TableBody>
                {pageRows.map((row) => {
                  const isOrphan = row.client_id === null;
                  // Top-level detail page at /admin/campaigns/[id] is
                  // orphan-safe and handles both linked and unlinked
                  // campaigns. The client-scoped URL still works for
                  // linked campaigns when entered via the client dossier.
                  const campaignHref = `/admin/campaigns/${row.id}`;
                  const clientHref = isOrphan ? null : `/admin/clients/${row.client_id}`;
                  return (
                    <TableRow key={row.id} href={campaignHref} className="group">
                      <TableCell><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0" style={{ background: '#2E37FE' }}><Mail size={14} /></div><Link href={campaignHref} className="font-medium text-foreground hover:text-[#2E37FE] transition-colors">{row.name}</Link></div></TableCell>
                      <TableCell>{clientHref ? <Link href={clientHref} className="text-muted-foreground hover:text-foreground transition-colors">{row.clientName || "—"}</Link> : <Badge variant="secondary" className="badge-amber">Unlinked</Badge>}</TableCell>
                      <TableCell><Badge variant="secondary" className={row.status === "active" ? "badge-green" : row.status === "paused" ? "badge-amber" : "badge-slate"}>{row.status}</Badge></TableCell>
                      <TableCell className="text-right font-medium">{row.metrics.emails_sent.toLocaleString()}</TableCell>
                      <TableCell className="text-right"><span className={row.metrics.reply_rate >= 5 ? "text-emerald-600 font-medium" : row.metrics.reply_rate >= 2 ? "text-amber-600" : "text-red-600"}>{row.metrics.reply_rate}%</span></TableCell>
                      <TableCell className="text-right"><span className={row.metrics.bounce_rate <= 2 ? "text-emerald-600" : "text-red-600 font-medium"}>{row.metrics.bounce_rate}%</span></TableCell>
                      <TableCell className="text-right font-medium">{row.metrics.meetings_booked}</TableCell>
                      <TableCell className="w-[80px]">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            href={campaignHref}
                            aria-label="Open campaign"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted/50 hover:text-foreground"
                          >
                            <ArrowRight size={14} />
                          </Link>
                          <CampaignRowActions
                            campaignId={row.id}
                            campaignName={row.name}
                            status={row.status as "active" | "paused" | "draft" | "completed" | null}
                            sourceChannel={row.source_channel}
                            onChanged={refetch}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
            <PaginationControls
              currentPage={safePage}
              totalItems={sorted.length}
              pageSize={CAMPAIGNS_PAGE_SIZE}
              onPageChange={setPage}
            />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

