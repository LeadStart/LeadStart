"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useSort } from "@/hooks/use-sort";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableHead } from "@/components/ui/sortable-head";
import { Bell, Mail, MailOpen, AlertTriangle, CalendarCheck, CheckCircle, Ban, Undo2, Loader2 } from "lucide-react";
import type { WebhookEvent } from "@/types/app";

const EVENT_STYLES: Record<string, { class: string; icon: React.ReactNode }> = {
  email_sent: { class: "badge-slate", icon: <Mail size={11} className="mr-1" /> },
  email_replied: { class: "badge-blue", icon: <MailOpen size={11} className="mr-1" /> },
  email_bounced: { class: "badge-red", icon: <AlertTriangle size={11} className="mr-1" /> },
  meeting_booked: { class: "badge-green", icon: <CalendarCheck size={11} className="mr-1" /> },
};

export default function WebhooksPage() {
  const { data: events, loading, setData } = useSupabaseQuery("admin-webhooks", async (supabase) => {
    const { data } = await supabase.from("webhook_events").select("*").order("received_at", { ascending: false }).limit(100);
    return (data || []) as WebhookEvent[];
  });

  const [togglingId, setTogglingId] = useState<string | null>(null);

  const eventsList = events || [];
  const { sorted, sortConfig, requestSort } = useSort(eventsList);
  const eventCounts = eventsList.reduce<Record<string, number>>((acc, e) => { acc[e.event_type] = (acc[e.event_type] || 0) + 1; return acc; }, {});
  const excludedCount = eventsList.filter((e) => e.excluded).length;

  async function toggleExclude(event: WebhookEvent) {
    setTogglingId(event.id);
    const newExcluded = !event.excluded;

    const res = await fetch("/api/admin/exclude-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: event.id, excluded: newExcluded }),
    });

    if (res.ok) {
      setData((prev) =>
        (prev || []).map((e) => (e.id === event.id ? { ...e, excluded: newExcluded } : e))
      );
    }
    setTogglingId(null);
  }

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="rounded-xl h-64 bg-muted/50" /></div>;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10"><p className="text-xs font-medium text-[#64748b]">Instantly.ai Webhooks</p><h1 className="text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Event Log</h1><p className="text-sm text-[#0f172a]/60 mt-1">{eventsList.length} events received{excludedCount > 0 ? ` · ${excludedCount} excluded` : ""}</p></div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>
      <div className="flex flex-wrap gap-2">
        {Object.entries(eventCounts).map(([type, count]) => {
          const style = EVENT_STYLES[type];
          return <Badge key={type} variant="secondary" className={style?.class || "badge-slate"}>{style?.icon}{type.replace(/_/g, " ")}: {count}</Badge>;
        })}
      </div>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]/10"><Bell size={16} className="text-[#2E37FE]" /></div>
        <h2 className="text-[15px] font-semibold text-[#0f172a]">Recent Events</h2>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          {eventsList.length === 0 ? <p className="text-sm text-muted-foreground">No webhook events received yet.</p> : (
            <Table>
              <TableHeader><TableRow><SortableHead sortKey="event_type" sortConfig={sortConfig} onSort={requestSort}>Type</SortableHead><SortableHead sortKey="lead_email" sortConfig={sortConfig} onSort={requestSort}>Lead</SortableHead><SortableHead sortKey="campaign_instantly_id" sortConfig={sortConfig} onSort={requestSort}>Campaign ID</SortableHead><SortableHead sortKey="processed" sortConfig={sortConfig} onSort={requestSort}>Processed</SortableHead><SortableHead sortKey="received_at" sortConfig={sortConfig} onSort={requestSort}>Received</SortableHead><TableHead className="w-[100px]">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {sorted.map((event) => {
                  const style = EVENT_STYLES[event.event_type];
                  const isExcludable = event.event_type === "meeting_booked" || event.event_type === "email_replied";
                  return (
                    <TableRow key={event.id} className={event.excluded ? "opacity-50" : ""}>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="secondary" className={`min-w-[120px] justify-center ${style?.class || "badge-slate"}`}>{style?.icon}{event.event_type.replace(/_/g, " ")}</Badge>
                          {event.excluded && <Badge className="bg-red-50 text-red-700 border border-red-200 text-[10px]"><Ban size={9} className="mr-0.5" />Excluded</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">{event.lead_email || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">{event.campaign_instantly_id || "—"}</TableCell>
                      <TableCell>{event.processed ? <Badge className="badge-green"><CheckCircle size={11} className="mr-1" /> Yes</Badge> : <Badge variant="secondary" className="badge-amber">Pending</Badge>}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{new Date(event.received_at).toLocaleString()}</TableCell>
                      <TableCell>
                        {isExcludable && (
                          <button
                            onClick={() => toggleExclude(event)}
                            disabled={togglingId === event.id}
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                              event.excluded
                                ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200"
                                : "bg-red-50 text-red-700 hover:bg-red-100 border border-red-200"
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                            title={event.excluded ? "Restore this lead" : "Exclude this lead from client metrics"}
                          >
                            {togglingId === event.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : event.excluded ? (
                              <><Undo2 size={12} /> Restore</>
                            ) : (
                              <><Ban size={12} /> Exclude</>
                            )}
                          </button>
                        )}
                      </TableCell>
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
