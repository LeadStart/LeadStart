"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import { Mail, MailOpen, AlertTriangle, CalendarCheck, Send, UserX, Activity } from "lucide-react";
import type { Client, Campaign, WebhookEvent } from "@/types/app";

const EVENT_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string; badgeClass: string }> = {
  email_sent: { label: "Email Sent", icon: <Send size={14} />, color: "text-gray-500", badgeClass: "bg-gray-100 text-gray-600 border border-gray-200" },
  email_replied: { label: "Reply Received", icon: <MailOpen size={14} />, color: "text-blue-500", badgeClass: "bg-blue-100 text-blue-700 border border-blue-200" },
  email_bounced: { label: "Bounced", icon: <AlertTriangle size={14} />, color: "text-red-500", badgeClass: "bg-red-100 text-red-700 border border-red-200" },
  meeting_booked: { label: "Meeting Booked", icon: <CalendarCheck size={14} />, color: "text-emerald-500", badgeClass: "bg-emerald-100 text-emerald-700 border border-emerald-200" },
  email_unsubscribed: { label: "Unsubscribed", icon: <UserX size={14} />, color: "text-amber-500", badgeClass: "bg-amber-100 text-amber-700 border border-amber-200" },
};

function getEventConfig(eventType: string) {
  return EVENT_CONFIG[eventType] || { label: eventType.replace(/_/g, " "), icon: <Mail size={14} />, color: "text-gray-500", badgeClass: "bg-gray-100 text-gray-600 border border-gray-200" };
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
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [campaignNameMap, setCampaignNameMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data: clientData } = await supabase.from("clients").select("*").eq("user_id", user.id).single();
      if (!clientData) { setLoading(false); return; }
      const client = clientData as Client;
      const { data: campaignsData } = await supabase.from("campaigns").select("*").eq("client_id", client.id);
      const campaigns = (campaignsData || []) as Campaign[];
      setCampaignNameMap(new Map(campaigns.map((c) => [c.instantly_campaign_id, c.name])));
      const ids = campaigns.map((c) => c.instantly_campaign_id);
      const { data: eventsData } = await supabase.from("webhook_events").select("*")
        .in("campaign_instantly_id", ids.length > 0 ? ids : ["none"])
        .order("received_at", { ascending: false });
      setEvents((eventsData || []) as WebhookEvent[]);
      setLoading(false);
    });
  }, []);

  if (loading) {
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
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Real-Time Updates</p>
          <h1 className="text-2xl font-bold mt-1">Activity Feed</h1>
          <p className="text-sm text-white/60 mt-1">{events.length} events across your campaigns</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Replies" value={replies} icon={<MailOpen size={16} className="text-blue-500" />} iconBg="bg-blue-50" />
        <StatCard label="Positive Responses" value={meetings} icon={<CalendarCheck size={16} className="text-emerald-500" />} iconBg="bg-emerald-50" />
        <StatCard label="Bounces" value={bounces} icon={<AlertTriangle size={16} className="text-red-500" />} iconBg="bg-red-50" />
        <StatCard label="Total" value={events.length} icon={<Activity size={16} className="text-indigo-500" />} iconBg="bg-indigo-50" />
      </div>

      {events.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <div className="flex justify-center mb-3"><div className="h-12 w-12 rounded-full bg-indigo-50 flex items-center justify-center"><Activity size={24} className="text-indigo-400" /></div></div>
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
