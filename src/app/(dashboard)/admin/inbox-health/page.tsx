"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatCard } from "@/components/charts/stat-card";
import { useSort } from "@/hooks/use-sort";
import { SortableHead } from "@/components/ui/sortable-head";
import { Inbox, Globe, Activity, AlertTriangle, Shield, RefreshCw } from "lucide-react";
import { appUrl } from "@/lib/api-url";

interface InboxData {
  email: string;
  domain: string;
  name: string | null;
  status: string;
  warmupStatus: number;
  healthScore: number | null;
  healthLabel?: string | null;
  landedInbox?: number;
  landedSpam?: number;
  inboxRate?: number | null;
  sent30d: number;
  dailyLimit?: number;
  campaigns?: { id: string; name: string }[];
  createdAt: string;
}

interface DomainData {
  domain: string;
  inboxCount: number;
  avgHealthScore: number | null;
  totalSent30d: number;
  inboxRate?: number | null;
}

interface InboxHealthResponse {
  inboxes: InboxData[];
  domains: DomainData[];
  summary: {
    totalInboxes: number;
    activeInboxes: number;
    avgHealthScore: number | null;
  };
}

function healthColor(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 80) return "text-emerald-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-600";
}

function healthBadge(score: number | null, label: string | null) {
  if (score === null) return <Badge variant="secondary" className="bg-gray-100 text-gray-500 border border-gray-200">No data</Badge>;
  if (score >= 80) return <Badge className="badge-green">{label || "Good"} ({score})</Badge>;
  if (score >= 50) return <Badge className="badge-amber">{label || "Fair"} ({score})</Badge>;
  return <Badge className="badge-red">{label || "Poor"} ({score})</Badge>;
}

function inboxRateBadge(rate: number | null) {
  if (rate === null) return <span className="text-muted-foreground">—</span>;
  if (rate >= 90) return <span className="text-emerald-600 font-medium">{rate}%</span>;
  if (rate >= 70) return <span className="text-amber-600 font-medium">{rate}%</span>;
  return <span className="text-red-600 font-bold">{rate}%</span>;
}

export default function InboxHealthPage() {
  const [data, setData] = useState<InboxHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"inboxes" | "domains">("domains");

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(appUrl("/api/instantly/inbox-health"));
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to fetch");
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch inbox health");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  const inboxRows = data?.inboxes || [];
  const domainRows = data?.domains || [];
  const { sorted: sortedInboxes, sortConfig: inboxSort, requestSort: requestInboxSort } = useSort(inboxRows, "healthScore", "asc");
  const { sorted: sortedDomains, sortConfig: domainSort, requestSort: requestDomainSort } = useSort(domainRows, "avgHealthScore", "asc");

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-36 bg-muted/50" />
        <div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <div key={i} className="rounded-xl h-24 bg-muted/50" />)}</div>
        <div className="rounded-xl h-64 bg-muted/50" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
          <div className="relative z-10">
            <p className="text-xs font-medium text-[#64748b]">Deliverability</p>
            <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Inbox Health</h1>
          </div>
        </div>
        <Card className="border-red-200">
          <CardContent className="py-8 text-center">
            <AlertTriangle size={32} className="text-red-700 mx-auto mb-3" />
            <p className="text-sm font-medium text-red-600">{error}</p>
            <button onClick={fetchData} className="mt-3 text-sm text-[#2E37FE] hover:underline">Retry</button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const summary = data?.summary || { totalInboxes: 0, activeInboxes: 0, avgHealthScore: null, lowHealthCount: 0 };
  const lowHealthInboxes = inboxRows.filter(i => i.healthScore !== null && i.healthScore < 50).length;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-[#64748b]">Deliverability</p>
            <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Inbox Health</h1>
            <p className="text-sm text-[#0f172a]/60 mt-1">{summary.totalInboxes} inboxes across {domainRows.length} domains</p>
          </div>
          <button onClick={fetchData} className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-[#0f172a] hover:bg-white/20 transition-colors">
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Active Inboxes" value={summary.activeInboxes} icon={<Inbox size={18} className="text-[#2E37FE]" />} iconBg="bg-[#2E37FE]/10" />
        <StatCard label="Avg Health Score" value={summary.avgHealthScore !== null ? `${summary.avgHealthScore}/100` : "N/A"} icon={<Shield size={18} className="text-emerald-500" />} iconBg="bg-emerald-50" valueColor={healthColor(summary.avgHealthScore)} />
        <StatCard label="Low Health Inboxes" value={lowHealthInboxes} icon={<AlertTriangle size={18} className="text-red-500" />} iconBg="bg-red-50" valueColor={lowHealthInboxes > 0 ? "text-red-600" : "text-emerald-600"} />
      </div>

      {/* View Toggle */}
      <div className="flex gap-2">
        <button onClick={() => setView("domains")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${view === "domains" ? "bg-[#2E37FE]/20 text-[#6B72FF] border border-[#2E37FE]/20" : "bg-muted/50 text-muted-foreground hover:bg-muted"}`}>
          <Globe size={14} /> By Domain
        </button>
        <button onClick={() => setView("inboxes")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${view === "inboxes" ? "bg-[#2E37FE]/20 text-[#6B72FF] border border-[#2E37FE]/20" : "bg-muted/50 text-muted-foreground hover:bg-muted"}`}>
          <Inbox size={14} /> By Inbox
        </button>
      </div>

      {view === "domains" ? (
        <>
        <div className="flex items-center gap-2 mb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]/10"><Globe size={16} className="text-[#2E37FE]" /></div>
          <h2 className="text-[15px] font-semibold text-[#0f172a]">Domain Health</h2>
        </div>
        <Card className="border-border/50 shadow-sm">
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="domain" sortConfig={domainSort} onSort={requestDomainSort}>Domain</SortableHead>
                  <SortableHead sortKey="inboxCount" sortConfig={domainSort} onSort={requestDomainSort} className="text-right">Inboxes</SortableHead>
                  <SortableHead sortKey="avgHealthScore" sortConfig={domainSort} onSort={requestDomainSort} className="text-right">Avg Health</SortableHead>
                  <SortableHead sortKey="inboxRate" sortConfig={domainSort} onSort={requestDomainSort} className="text-right">Inbox Rate</SortableHead>
                  <SortableHead sortKey="totalSent30d" sortConfig={domainSort} onSort={requestDomainSort} className="text-right">Sent (30d)</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedDomains.map((d) => (
                  <TableRow key={d.domain}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded bg-[#2E37FE]/10 text-[10px] font-bold text-[#2E37FE]">{d.domain.charAt(0).toUpperCase()}</div>
                        <span className="font-medium">{d.domain}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{d.inboxCount}</TableCell>
                    <TableCell className="text-right">{d.avgHealthScore !== null ? healthBadge(d.avgHealthScore, null) : <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-right">{inboxRateBadge(d.inboxRate)}</TableCell>
                    <TableCell className="text-right font-medium">{d.totalSent30d.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        </>
      ) : (
        <>
        <div className="flex items-center gap-2 mb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]/10"><Inbox size={16} className="text-[#2E37FE]" /></div>
          <h2 className="text-[15px] font-semibold text-[#0f172a]">All Inboxes</h2>
        </div>
        <Card className="border-border/50 shadow-sm">
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="email" sortConfig={inboxSort} onSort={requestInboxSort}>Inbox</SortableHead>
                  <SortableHead sortKey="status" sortConfig={inboxSort} onSort={requestInboxSort}>Status</SortableHead>
                  <SortableHead sortKey="healthScore" sortConfig={inboxSort} onSort={requestInboxSort} className="text-right">Health</SortableHead>
                  <SortableHead sortKey="inboxRate" sortConfig={inboxSort} onSort={requestInboxSort} className="text-right">Inbox Rate</SortableHead>
                  <SortableHead sortKey="sent30d" sortConfig={inboxSort} onSort={requestInboxSort} className="text-right">Sent (30d)</SortableHead>
                  <TableHead>Campaigns</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedInboxes.map((inbox) => (
                  <TableRow key={inbox.email}>
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">{inbox.email}</p>
                        <p className="text-xs text-muted-foreground">{inbox.domain}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={inbox.status === "active" ? "badge-green" : "badge-slate"}>
                        {inbox.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{healthBadge(inbox.healthScore, inbox.healthLabel)}</TableCell>
                    <TableCell className="text-right">{inboxRateBadge(inbox.inboxRate)}</TableCell>
                    <TableCell className="text-right font-medium">{inbox.sent30d.toLocaleString()}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {!inbox.campaigns || inbox.campaigns.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          inbox.campaigns.slice(0, 3).map((c) => (
                            <Badge key={c.id} variant="secondary" className="bg-[#2E37FE]/10 text-[#6B72FF] border border-[#2E37FE]/20 text-[10px]">
                              {c.name.length > 20 ? c.name.slice(0, 20) + "…" : c.name}
                            </Badge>
                          ))
                        )}
                        {inbox.campaigns && inbox.campaigns.length > 3 && (
                          <Badge variant="secondary" className="bg-gray-100 text-gray-500 text-[10px]">+{inbox.campaigns.length - 3}</Badge>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        </>
      )}
    </div>
  );
}
