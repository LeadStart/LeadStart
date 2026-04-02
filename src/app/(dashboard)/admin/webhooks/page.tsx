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
  email_sent: { class: "bg-gray-100 text-gray-600 border border-gray-200", icon: <Mail size={11} className="mr-1" /> },
  email_replied: { class: "bg-blue-100 text-blue-700 border border-blue-200", icon: <MailOpen size={11} className="mr-1" /> },
  email_bounced: { class: "bg-red-100 text-red-700 border border-red-200", icon: <AlertTriangle size={11} className="mr-1" /> },
  meeting_booked: { class: "bg-emerald-100 text-emerald-700 border border-emerald-200", icon: <CalendarCheck size={11} className="mr-1" /> },
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
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10"><p className="text-sm font-medium text-white/70">Instantly.ai Webhooks</p><h1 className="text-2xl font-bold mt-1">Event Log</h1><p className="text-sm text-white/60 mt-1">{eventsList.length} events received{excludedCount > 0 ? ` · ${excludedCount} excluded` : ""}</p></div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>
      <div className="flex flex-wrap gap-2">
        {Object.entries(eventCounts).map(([type, count]) => {
          const style = EVENT_STYLES[type];
          return <Badge key={type} variant="secondary" className={style?.class || "bg-gray-100 text-gray-600 border border-gray-200"}>{style?.icon}{type.replace(/_/g, " ")}: {count}</Badge>;
        })}
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50"><Bell size={16} className="text-indigo-500" /></div><CardTitle className="text-base">Recent Events</CardTitle></CardHeader>
        <CardContent>
          {eventsList.length === 0 ? <p className="text-sm text-muted-foreground">No webhook events received yet.</p> : (
            <Table>
              <TableHeader><TableRow><SortableHead sortKey="event_type" sortConfig={sortConfig} onSort={requestSort}>Type</SortableHead><SortableHead sortKey="lead_email" sortConfig={sortConfig} onSort={requestSort}>Lead</SortableHead><SortableHead sortKey="campaign_instantly_id" sortConfig={sortConfig} onSort={requestSort}>Campaign ID</SortableHead><SortableHead sortKey="processed" sortConfig={sortConfig} onSort={requestSort}>Processed</SortableHead><SortableHead sortKey="received_at" sortConfig={sortConfig} onSort={requestSort}>Received</SortableHead><TableHead className="w-[100px]">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {sorted.map((event) => {
                  const style = EVENT_STYLES[event.event_type];
                  const isExcludable = event.event_type === "meeting_booked" || event.event_type === "email_replied";
                  return (
                    <TableRow key={event.id} className={event.excluded ? "opacity-50 bg-red-50/30" : ""}>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="secondary" className={style?.class || "bg-gray-100 text-gray-600 border border-gray-200"}>{style?.icon}{event.event_type.replace(/_/g, " ")}</Badge>
                          {event.excluded && <Badge className="bg-red-100 text-red-600 border border-red-200 text-[10px]"><Ban size={9} className="mr-0.5" />Excluded</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">{event.lead_email || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">{event.campaign_instantly_id || "—"}</TableCell>
                      <TableCell>{event.processed ? <Badge className="bg-emerald-100 text-emerald-700 border border-emerald-200"><CheckCircle size={11} className="mr-1" /> Yes</Badge> : <Badge variant="secondary" className="bg-amber-100 text-amber-700 border border-amber-200">Pending</Badge>}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{new Date(event.received_at).toLocaleString()}</TableCell>
                      <TableCell>
                        {isExcludable && (
                          <button
                            onClick={() => toggleExclude(event)}
                            disabled={togglingId === event.id}
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                              event.excluded
                                ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200"
                                : "bg-red-50 text-red-600 hover:bg-red-100 border border-red-200"
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
