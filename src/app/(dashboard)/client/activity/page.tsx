"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useClientData } from "../client-data-context";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import { Mail, MailOpen, AlertTriangle, CalendarCheck, Send, UserX, Activity } from "lucide-react";
import type { WebhookEvent } from "@/types/app";

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
  const { client, campaigns, loading: contextLoading } = useClientData();
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [campaignNameMap, setCampaignNameMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (contextLoading || !client) return;
    setCampaignNameMap(new Map(campaigns.map((c) => [c.instantly_campaign_id, c.name])));
    const ids = campaigns.map((c) => c.instantly_campaign_id);
    const supabase = createClient();
    supabase.from("webhook_events").select("*")
      .in("campaign_instantly_id", ids.length > 0 ? ids : ["none"])
      .order("received_at", { ascending: false })
      .then(({ data: eventsData }) => {
        setEvents((eventsData || []) as WebhookEvent[]);
        setLoading(false);
      });
  }, [contextLoading, client, campaigns]);

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

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Real-Time Updates</p>
          <h1 className="text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Activity Feed</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">{events.length} events across your campaigns</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard label="Replies" value={replies} icon={<MailOpen size={16} className="text-blue-500" />} iconBg="bg-blue-50" />
        <StatCard label="Positive Responses" value={meetings} icon={<CalendarCheck size={16} className="text-emerald-500" />} iconBg="bg-emerald-50" />
        <StatCard label="Total" value={events.length} icon={<Activity size={16} className="text-[#2E37FE]" />} iconBg="bg-[#2E37FE]/10" />
      </div>

      {events.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <div className="flex justify-center mb-3"><div className="h-12 w-12 rounded-full bg-[#2E37FE]/10 flex items-center justify-center"><Activity size={24} className="text-[#1C24B8]" /></div></div>
            <p className="text-muted-foreground font-medium">No activity yet</p>
            <p className="text-sm text-muted-foreground">Events will appear here as your campaigns run.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {Array.from(grouped.entries()).map(([dateLabel, dayEvents]) => (
            <div key={dateLabel}>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 px-1">{dateLabel}</p>
              <Card className="border-border/50 shadow-sm">
                <CardContent className="py-2">
                  {dayEvents.map((event, i) => {
                    const config = getEventConfig(event.event_type);
                    const campaignName = event.campaign_instantly_id ? campaignNameMap.get(event.campaign_instantly_id) : null;
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
        </div>
      )}
    </div>
  );
}
