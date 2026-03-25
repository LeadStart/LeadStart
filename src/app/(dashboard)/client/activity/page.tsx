"use client";

import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import {
  Mail,
  MailOpen,
  AlertTriangle,
  CalendarCheck,
  Send,
  UserX,
  Activity,
} from "lucide-react";
import type { Client, Campaign, WebhookEvent } from "@/types/app";

const EVENT_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string; badgeClass: string }> = {
  email_sent: {
    label: "Email Sent",
    icon: <Send size={14} />,
    color: "text-gray-500",
    badgeClass: "bg-gray-100 text-gray-600 border border-gray-200",
  },
  email_replied: {
    label: "Reply Received",
    icon: <MailOpen size={14} />,
    color: "text-blue-500",
    badgeClass: "bg-blue-100 text-blue-700 border border-blue-200",
  },
  email_bounced: {
    label: "Bounced",
    icon: <AlertTriangle size={14} />,
    color: "text-red-500",
    badgeClass: "bg-red-100 text-red-700 border border-red-200",
  },
  meeting_booked: {
    label: "Meeting Booked",
    icon: <CalendarCheck size={14} />,
    color: "text-emerald-500",
    badgeClass: "bg-emerald-100 text-emerald-700 border border-emerald-200",
  },
  email_unsubscribed: {
    label: "Unsubscribed",
    icon: <UserX size={14} />,
    color: "text-amber-500",
    badgeClass: "bg-amber-100 text-amber-700 border border-amber-200",
  },
};

function getEventConfig(eventType: string) {
  return EVENT_CONFIG[eventType] || {
    label: eventType.replace(/_/g, " "),
    icon: <Mail size={14} />,
    color: "text-gray-500",
    badgeClass: "bg-gray-100 text-gray-600 border border-gray-200",
  };
}

function getRelativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const supabase = createClient();

async function fetchClientActivity() {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return { client: null, events: [], campaigns: [] };

  const { data: clientData } = await supabase
    .from("clients")
    .select("*")
    .eq("user_id", user.id)
    .single();

  const client = clientData as Client | null;
  if (!client) return { client: null, events: [], campaigns: [] };

  const { data: campaignsData } = await supabase
    .from("campaigns")
    .select("*")
    .eq("client_id", client.id);

  const campaigns = (campaignsData || []) as Campaign[];
  const campaignInstantlyIds = campaigns.map((c) => c.instantly_campaign_id);

  const { data: eventsData } = await supabase
    .from("webhook_events")
    .select("*")
    .in("campaign_instantly_id", campaignInstantlyIds.length > 0 ? campaignInstantlyIds : ["none"])
    .order("received_at", { ascending: false });

  return {
    client,
    events: (eventsData || []) as WebhookEvent[],
    campaigns,
  };
}

export default function ClientActivityPage() {
  const { data } = useSWR("client-activity", fetchClientActivity);

  if (!data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-32 rounded-xl bg-muted" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-muted" />
          ))}
        </div>
        <div className="h-64 rounded-xl bg-muted" />
      </div>
    );
  }

  const { client, events, campaigns } = data;

  if (!client) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Your account is being set up.</p>
      </div>
    );
  }

  const campaignNameMap = new Map(campaigns.map((c) => [c.instantly_campaign_id, c.name]));

  // Summary counts
  const totalEvents = events.length;
  const replies = events.filter((e) => e.event_type === "email_replied").length;
  const meetings = events.filter((e) => e.event_type === "meeting_booked").length;
  const bounces = events.filter((e) => e.event_type === "email_bounced").length;

  // Group events by date
  const grouped = new Map<string, WebhookEvent[]>();
  events.forEach((event) => {
    const dateKey = new Date(event.received_at).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const existing = grouped.get(dateKey) || [];
    existing.push(event);
    grouped.set(dateKey, existing);
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Real-Time Updates</p>
          <h1 className="text-2xl font-bold mt-1">Activity Feed</h1>
          <p className="text-sm text-white/60 mt-1">
            {totalEvents} events across your campaigns
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="Replies"
          value={replies}
          icon={<MailOpen size={16} className="text-blue-500" />}
          iconBg="bg-blue-50"
        />
        <StatCard
          label="Meetings"
          value={meetings}
          icon={<CalendarCheck size={16} className="text-emerald-500" />}
          iconBg="bg-emerald-50"
        />
        <StatCard
          label="Bounces"
          value={bounces}
          icon={<AlertTriangle size={16} className="text-red-500" />}
          iconBg="bg-red-50"
        />
        <StatCard
          label="Total"
          value={totalEvents}
          icon={<Activity size={16} className="text-indigo-500" />}
          iconBg="bg-indigo-50"
        />
      </div>

      {/* Timeline */}
      {events.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <div className="flex justify-center mb-3">
              <div className="h-12 w-12 rounded-full bg-indigo-50 flex items-center justify-center">
                <Activity size={24} className="text-indigo-400" />
              </div>
            </div>
            <p className="text-muted-foreground font-medium">No activity yet</p>
            <p className="text-sm text-muted-foreground">Events will appear here as your campaigns run.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {Array.from(grouped.entries()).map(([dateLabel, dayEvents]) => (
            <div key={dateLabel}>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 px-1">
                {dateLabel}
              </p>
              <Card className="border-border/50 shadow-sm">
                <CardContent className="py-2">
                  {dayEvents.map((event, i) => {
                    const config = getEventConfig(event.event_type);
                    const campaignName = event.campaign_instantly_id
                      ? campaignNameMap.get(event.campaign_instantly_id)
                      : null;

                    return (
                      <div
                        key={event.id}
                        className={`flex items-center gap-4 py-3 ${
                          i < dayEvents.length - 1 ? "border-b border-border/30" : ""
                        }`}
                      >
                        {/* Icon */}
                        <div className={`flex h-9 w-9 items-center justify-center rounded-full bg-muted/50 ${config.color} shrink-0`}>
                          {config.icon}
                        </div>

                        {/* Details */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className={config.badgeClass}>
                              {config.label}
                            </Badge>
                            {campaignName && (
                              <span className="text-xs text-muted-foreground truncate hidden sm:inline">
                                {campaignName}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-foreground mt-0.5 truncate">
                            {event.lead_email || "—"}
                          </p>
                        </div>

                        {/* Time */}
                        <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                          {getRelativeTime(event.received_at)}
                        </span>
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
