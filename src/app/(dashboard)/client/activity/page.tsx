"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useClientData } from "../client-data-context";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Mail, MailOpen, AlertTriangle, CalendarCheck, Send, UserX, Activity } from "lucide-react";
import type { WebhookEvent } from "@/types/app";

const ACTIVITY_PAGE_SIZE = 25; // pages slice date groups, not individual events

const EVENT_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string; badgeClass: string }> = {
  email_sent: { label: "Email Sent", icon: <Send size={14} />, color: "text-gray-500", badgeClass: "badge-slate" },
  email_replied: { label: "Reply Received", icon: <MailOpen size={14} />, color: "text-blue-500", badgeClass: "badge-blue" },
  email_bounced: { label: "Bounced", icon: <AlertTriangle size={14} />, color: "text-red-500", badgeClass: "badge-red" },
  meeting_booked: { label: "Meeting Booked", icon: <CalendarCheck size={14} />, color: "text-emerald-500", badgeClass: "badge-green" },
  email_unsubscribed: { label: "Unsubscribed", icon: <UserX size={14} />, color: "text-amber-500", badgeClass: "badge-amber" },
};

function getEventConfig(eventType: string) {
  return EVENT_CONFIG[eventType] || { label: eventType.replace(/_/g, " "), icon: <Mail size={14} />, color: "text-gray-500", badgeClass: "badge-slate" };
}

function getRelativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ClientActivityPage() {
  const { client, loading: contextLoading } = useClientData();
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [campaignNameMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  // Activity feed temporarily empty — the old query joined webhook_events
  // to campaigns via campaign_instantly_id (dropped in migration 00051).
  // Rebuild against the Salesforge webhook event stream once we wire a
  // campaign_id FK into webhook_events.
  useEffect(() => {
    if (contextLoading || !client) return;
    setEvents([]);
    setLoading(false);
  }, [contextLoading, client]);

  if (contextLoading || loading) {
    return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="grid grid-cols-4 gap-4">{[1,2,3,4].map(i => <div key={i} className="rounded-xl h-24 bg-muted/50" />)}</div><div className="rounded-xl h-64 bg-muted/50" /></div>;
  }

  const replies = events.filter((e) => e.event_type === "email_replied").length;
  const meetings = events.filter((e) => e.event_type === "meeting_booked").length;
  const bounces = events.filter((e) => e.event_type === "email_bounced").length;

  const grouped = new Map<string, WebhookEvent[]>();
  events.forEach((event) => {
    const dateKey = new Date(event.received_at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const existing = grouped.get(dateKey) || [];
    existing.push(event);
    grouped.set(dateKey, existing);
  });

  const groupEntries = Array.from(grouped.entries());
  const totalPages = Math.max(1, Math.ceil(groupEntries.length / ACTIVITY_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * ACTIVITY_PAGE_SIZE;
  const pageGroups = groupEntries.slice(pageStart, pageStart + ACTIVITY_PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[12px] p-5 sm:p-7 text-[#0f172a]" style={{ background: '#EDEEFF', border: '1px solid #e2e8f0', borderTop: '1px solid #e2e8f0', boxShadow: 'none' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Real-Time Updates</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Activity Feed</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">{events.length} events across your campaigns</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-transparent" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard label="Replies" value={replies} icon={<MailOpen size={16} className="text-blue-500" />} iconBg="bg-blue-50" />
        <StatCard label="Positive Responses" value={meetings} icon={<CalendarCheck size={16} className="text-emerald-500" />} iconBg="bg-emerald-50" />
        <StatCard label="Total" value={events.length} icon={<Activity size={16} className="text-[#2E37FE]" />} iconBg="bg-[#2E37FE]/10" />
      </div>

      {events.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <div className="flex justify-center mb-3"><div className="h-12 w-12 rounded-full bg-[#2E37FE] flex items-center justify-center"><Activity size={24} className="text-white" /></div></div>
            <p className="text-muted-foreground font-medium">No activity yet</p>
            <p className="text-sm text-muted-foreground">Events will appear here as your campaigns run.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {pageGroups.map(([dateLabel, dayEvents]) => (
            <div key={dateLabel}>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 px-1">{dateLabel}</p>
              <Card className="border-border/50 shadow-sm">
                <CardContent className="py-2">
                  {dayEvents.map((event, i) => {
                    const config = getEventConfig(event.event_type);
                    // campaign_instantly_id dropped in migration 00051;
                    // wire a proper campaign_id FK when events get rebuilt.
                    const campaignName = campaignNameMap.get(event.id);
                    return (
                      <div key={event.id} className={`flex items-center gap-4 py-3 ${i < dayEvents.length - 1 ? "border-b border-border/30" : ""}`}>
                        <div className={`flex h-9 w-9 items-center justify-center rounded-full bg-muted/50 ${config.color} shrink-0`}>{config.icon}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className={config.badgeClass}>{config.label}</Badge>
                            {campaignName && <span className="text-xs text-muted-foreground truncate hidden sm:inline">{campaignName}</span>}
                          </div>
                          <p className="text-sm text-foreground mt-0.5 truncate">{event.lead_email || "—"}</p>
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">{getRelativeTime(event.received_at)}</span>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </div>
          ))}
          <PaginationControls
            currentPage={safePage}
            totalItems={groupEntries.length}
            pageSize={ACTIVITY_PAGE_SIZE}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
