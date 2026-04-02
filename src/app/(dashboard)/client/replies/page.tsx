"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import { MailOpen, Send, CalendarCheck, Clock, ChevronDown, ChevronUp } from "lucide-react";
import type { Client, Campaign, WebhookEvent } from "@/types/app";

interface LeadThread {
  leadEmail: string;
  campaignName: string;
  events: WebhookEvent[];
  firstSent: string | null;
  lastReply: string | null;
  hasReply: boolean;
  hasMeeting: boolean;
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function getTimeBetween(start: string, end: string): string {
  const diffMs = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${days}d ${hours % 24}h`;
}

const EVENT_ICONS: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  email_sent: { icon: <Send size={14} />, color: "text-gray-500 bg-gray-100", label: "Email Sent" },
  email_replied: { icon: <MailOpen size={14} />, color: "text-blue-500 bg-blue-100", label: "Reply Received" },
  meeting_booked: { icon: <CalendarCheck size={14} />, color: "text-emerald-500 bg-emerald-100", label: "Meeting Booked" },
};

function ThreadCard({ thread }: { thread: LeadThread }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="border-border/50 shadow-sm overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-5 py-4 flex items-center gap-4 hover:bg-muted/30 transition-colors cursor-pointer"
      >
        {/* Status indicator */}
        <div className={`flex h-10 w-10 items-center justify-center rounded-full shrink-0 ${thread.hasMeeting ? "bg-emerald-100 text-emerald-600" : thread.hasReply ? "bg-blue-100 text-blue-600" : "bg-gray-100 text-gray-500"}`}>
          {thread.hasMeeting ? <CalendarCheck size={18} /> : thread.hasReply ? <MailOpen size={18} /> : <Send size={18} />}
        </div>

        {/* Lead info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium text-sm truncate">{thread.leadEmail}</p>
            {thread.hasMeeting && (
              <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 border border-emerald-200 text-[10px]">Meeting</Badge>
            )}
            {thread.hasReply && !thread.hasMeeting && (
              <Badge variant="secondary" className="bg-blue-100 text-blue-700 border border-blue-200 text-[10px]">Replied</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{thread.campaignName}</p>
        </div>

        {/* Response time */}
        {thread.firstSent && thread.lastReply && (
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Clock size={12} />
            <span>{getTimeBetween(thread.firstSent, thread.lastReply)} to reply</span>
          </div>
        )}

        {/* Event count + expand */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">{thread.events.length} events</span>
          {expanded ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
        </div>
      </button>

      {/* Expanded timeline */}
      {expanded && (
        <div className="border-t border-border/50 bg-muted/20 px-5 py-4">
          <div className="relative pl-6">
            {/* Vertical line */}
            <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />

            {thread.events.map((event, i) => {
              const config = EVENT_ICONS[event.event_type] || { icon: <Send size={14} />, color: "text-gray-500 bg-gray-100", label: event.event_type.replace(/_/g, " ") };
              return (
                <div key={event.id} className={`relative flex items-start gap-3 ${i < thread.events.length - 1 ? "pb-4" : ""}`}>
                  {/* Dot on timeline */}
                  <div className={`absolute -left-6 flex h-[22px] w-[22px] items-center justify-center rounded-full ${config.color} shrink-0 z-10`}>
                    {config.icon}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{config.label}</p>
                    <p className="text-xs text-muted-foreground">{formatDateTime(event.received_at)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function ClientRepliesPage() {
  const [threads, setThreads] = useState<LeadThread[]>([]);
  const [filter, setFilter] = useState<"all" | "replied" | "meetings">("all");
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
      const campaignNameMap = new Map(campaigns.map((c) => [c.instantly_campaign_id, c.name]));
      const ids = campaigns.map((c) => c.instantly_campaign_id);

      const { data: eventsData } = await supabase
        .from("webhook_events")
        .select("*")
        .in("campaign_instantly_id", ids.length > 0 ? ids : ["none"])
        .in("event_type", ["email_sent", "email_replied", "meeting_booked"])
        .order("received_at", { ascending: true });

      const events = (eventsData || []) as WebhookEvent[];

      // Group events by lead email
      const leadMap = new Map<string, WebhookEvent[]>();
      events.forEach((e) => {
        if (!e.lead_email) return;
        const key = `${e.lead_email}::${e.campaign_instantly_id}`;
        const existing = leadMap.get(key) || [];
        existing.push(e);
        leadMap.set(key, existing);
      });

      // Build threads
      const builtThreads: LeadThread[] = Array.from(leadMap.entries()).map(([key, evts]) => {
        const [leadEmail] = key.split("::");
        const campaignId = evts[0]?.campaign_instantly_id;
        const campaignName = campaignId ? campaignNameMap.get(campaignId) || "Unknown Campaign" : "Unknown Campaign";
        const sentEvents = evts.filter((e) => e.event_type === "email_sent");
        const replyEvents = evts.filter((e) => e.event_type === "email_replied");
        const meetingEvents = evts.filter((e) => e.event_type === "meeting_booked");

        return {
          leadEmail,
          campaignName,
          events: evts,
          firstSent: sentEvents.length > 0 ? sentEvents[0].received_at : null,
          lastReply: replyEvents.length > 0 ? replyEvents[replyEvents.length - 1].received_at : null,
          hasReply: replyEvents.length > 0,
          hasMeeting: meetingEvents.length > 0,
        };
      });

      // Sort: meetings first, then replies, then sent-only — most recent first within each group
      builtThreads.sort((a, b) => {
        if (a.hasMeeting !== b.hasMeeting) return a.hasMeeting ? -1 : 1;
        if (a.hasReply !== b.hasReply) return a.hasReply ? -1 : 1;
        const aTime = a.lastReply || a.firstSent || "";
        const bTime = b.lastReply || b.firstSent || "";
        return bTime.localeCompare(aTime);
      });

      setThreads(builtThreads);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-36 bg-muted/50" />
        <div className="grid grid-cols-3 gap-4">{[1, 2, 3].map((i) => <div key={i} className="rounded-xl h-24 bg-muted/50" />)}</div>
        <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="rounded-xl h-20 bg-muted/50" />)}</div>
      </div>
    );
  }

  const totalReplies = threads.filter((t) => t.hasReply).length;
  const totalMeetings = threads.filter((t) => t.hasMeeting).length;

  const filtered = threads.filter((t) => {
    if (filter === "replied") return t.hasReply;
    if (filter === "meetings") return t.hasMeeting;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: "linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)", boxShadow: "0 10px 30px -5px rgba(99, 102, 241, 0.2)" }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Campaign Responses</p>
          <h1 className="text-2xl font-bold mt-1">Replies</h1>
          <p className="text-sm text-white/60 mt-1">Track every lead interaction across your campaigns</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard label="Total Leads" value={threads.length} icon={<Send size={16} className="text-indigo-500" />} iconBg="bg-indigo-50" />
        <StatCard label="Replied" value={totalReplies} icon={<MailOpen size={16} className="text-blue-500" />} iconBg="bg-blue-50" />
        <StatCard label="Meetings Booked" value={totalMeetings} icon={<CalendarCheck size={16} className="text-emerald-500" />} iconBg="bg-emerald-50" />
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {([
          { key: "all", label: "All Leads", count: threads.length },
          { key: "replied", label: "Replied", count: totalReplies },
          { key: "meetings", label: "Meetings", count: totalMeetings },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              filter === tab.key
                ? "bg-indigo-100 text-indigo-700 border border-indigo-200"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      {/* Thread list */}
      {filtered.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <div className="flex justify-center mb-3">
              <div className="h-12 w-12 rounded-full bg-indigo-50 flex items-center justify-center">
                <MailOpen size={24} className="text-indigo-400" />
              </div>
            </div>
            <p className="text-muted-foreground font-medium">No replies yet</p>
            <p className="text-sm text-muted-foreground">Replies will appear here as leads respond to your campaigns.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((thread) => (
            <ThreadCard key={`${thread.leadEmail}::${thread.campaignName}`} thread={thread} />
          ))}
        </div>
      )}
    </div>
  );
}
