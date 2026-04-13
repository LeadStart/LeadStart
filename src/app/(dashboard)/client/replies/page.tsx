"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useClientData } from "../client-data-context";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import {
  MailOpen,
  Send,
  CalendarCheck,
  Clock,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Loader2,
  X,
} from "lucide-react";
import type { Client, Campaign, WebhookEvent } from "@/types/app";

// ===== Types =====

interface LeadNote {
  id: string;
  status: string;
  comment: string | null;
  created_at: string;
}

interface LeadThread {
  leadEmail: string;
  leadName: string | null;
  leadCompany: string | null;
  campaignName: string;
  campaignId: string; // DB UUID for feedback inserts
  campaignInstantlyId: string;
  events: WebhookEvent[];
  firstSent: string | null;
  lastReply: string | null;
  hasReply: boolean;
  hasMeeting: boolean;
  notes: LeadNote[];
}

// ===== Helpers =====

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

function formatReplyHtml(raw: string): string {
  const isHtml =
    raw.includes("<div") ||
    raw.includes("<p") ||
    raw.includes("<br") ||
    raw.includes("<table");

  if (isHtml) {
    const quotePatterns = [
      /(<div[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>[\s\S]*$)/i,
      /(<blockquote[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>[\s\S]*$)/i,
      /(<blockquote[\s\S]*$)/i,
      /(On\s+\w{3},\s+\w{3}\s+\d{1,2},\s+\d{4}[\s\S]*wrote:[\s\S]*$)/i,
    ];

    for (const pattern of quotePatterns) {
      const match = raw.match(pattern);
      if (match && match.index !== undefined && match.index > 20) {
        const replyPart = raw.substring(0, match.index);
        const quotedPart = raw.substring(match.index);
        return `${replyPart}<details class="mt-3"><summary class="text-xs text-muted-foreground cursor-pointer hover:text-foreground">Show original message</summary><div class="mt-2 pl-3 border-l-2 border-gray-200 text-xs text-muted-foreground">${quotedPart}</div></details>`;
      }
    }
    return raw;
  }

  // Plain text
  const lines = raw.split("\n");
  const replyLines: string[] = [];
  const quotedLines: string[] = [];
  let inQuote = false;

  for (const line of lines) {
    if (line.startsWith(">") || line.startsWith("&gt;")) {
      inQuote = true;
      quotedLines.push(line.replace(/^>\s?/, "").replace(/^&gt;\s?/, ""));
    } else if (inQuote) {
      quotedLines.push(line);
    } else {
      replyLines.push(line);
    }
  }

  let html = replyLines.join("\n").trim().replace(/\n/g, "<br>");

  if (quotedLines.length > 0) {
    const quotedHtml = quotedLines.join("\n").trim().replace(/\n/g, "<br>");
    html += `<details class="mt-3"><summary class="text-xs text-muted-foreground cursor-pointer hover:text-foreground">Show original message</summary><div class="mt-2 pl-3 border-l-2 border-gray-200 text-xs text-muted-foreground">${quotedHtml}</div></details>`;
  }

  return html;
}

// ===== Event Icons =====

const EVENT_ICONS: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  email_sent: { icon: <Send size={14} />, color: "text-gray-500 bg-gray-100", label: "Email Sent" },
  email_replied: { icon: <MailOpen size={14} />, color: "text-blue-500 bg-blue-100", label: "Reply Received" },
  meeting_booked: { icon: <CalendarCheck size={14} />, color: "text-emerald-500 bg-emerald-100", label: "Meeting Booked" },
};

// ===== Thread Card =====

function ThreadCard({
  thread,
  userId,
  onNoteAdded,
  onNoteDeleted,
}: {
  thread: LeadThread;
  userId: string;
  onNoteAdded: (threadKey: string, note: LeadNote) => void;
  onNoteDeleted: (threadKey: string, noteId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const threadKey = `${thread.leadEmail}::${thread.campaignInstantlyId}`;

  async function handleSubmitNote() {
    if (!noteText.trim()) return;
    setSubmitting(true);

    const supabase = createClient();
    const { data, error } = await supabase
      .from("lead_feedback")
      .insert({
        campaign_id: thread.campaignId,
        lead_email: thread.leadEmail,
        lead_name: thread.leadName || null,
        lead_company: thread.leadCompany || null,
        status: "other",
        comment: noteText.trim(),
        submitted_by: userId,
      })
      .select("id, status, comment, created_at")
      .single();

    setSubmitting(false);

    if (!error && data) {
      onNoteAdded(threadKey, data as LeadNote);
      setNoteText("");
    }
  }

  async function handleDeleteNote(noteId: string) {
    setDeletingId(noteId);
    const supabase = createClient();
    const { error } = await supabase.from("lead_feedback").delete().eq("id", noteId);
    setDeletingId(null);
    if (!error) {
      onNoteDeleted(threadKey, noteId);
    }
  }

  return (
    <Card className="border-border/50 shadow-sm overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-5 py-4 flex items-center gap-4 hover:bg-muted/30 transition-colors cursor-pointer"
      >
        {/* Status indicator */}
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-full shrink-0 ${
            thread.hasMeeting
              ? "bg-emerald-100 text-emerald-600"
              : thread.hasReply
              ? "bg-blue-100 text-blue-600"
              : "bg-gray-100 text-gray-500"
          }`}
        >
          {thread.hasMeeting ? (
            <CalendarCheck size={18} />
          ) : thread.hasReply ? (
            <MailOpen size={18} />
          ) : (
            <Send size={18} />
          )}
        </div>

        {/* Lead info */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{thread.leadEmail}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {thread.leadName && <span className="font-medium text-foreground/70">{thread.leadName}</span>}
            {thread.leadName && thread.leadCompany && <span> · </span>}
            {thread.leadCompany && <span>{thread.leadCompany}</span>}
            {(thread.leadName || thread.leadCompany) && <span> · </span>}
            {thread.campaignName}
          </p>
        </div>

        {/* Status column */}
        <div className="w-24 shrink-0 text-center hidden sm:block">
          {thread.hasMeeting ? (
            <Badge variant="secondary" className="badge-green text-[10px]">Meeting</Badge>
          ) : thread.hasReply ? (
            <Badge variant="secondary" className="badge-blue text-[10px]">Replied</Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>

        {/* Notes column */}
        <div className="w-20 shrink-0 text-center hidden sm:block">
          {thread.notes.length > 0 ? (
            <Badge variant="secondary" className="badge-amber text-[10px]">
              {thread.notes.length} note{thread.notes.length > 1 ? "s" : ""}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>

        {/* Response time — always rendered for column alignment */}
        <div className="hidden lg:flex items-center gap-1.5 text-xs text-muted-foreground shrink-0 w-20">
          {thread.firstSent && thread.lastReply ? (
            <>
              <Clock size={12} />
              <span>{getTimeBetween(thread.firstSent, thread.lastReply)}</span>
            </>
          ) : (
            <span>—</span>
          )}
        </div>

        {/* Expand */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">{thread.events.length} events</span>
          {expanded ? (
            <ChevronUp size={16} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={16} className="text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/50">
          {/* Notes + Add Note — TOP of expanded card */}
          <div className="px-5 py-4 bg-gradient-to-b from-amber-50/50 to-transparent">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare size={14} className="text-amber-600" />
              <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide">Interaction Notes</p>
            </div>

            {/* Existing notes */}
            {thread.notes.length > 0 && (
              <div className="space-y-2 mb-3">
                {thread.notes.map((note) => (
                  <div key={note.id} className="flex items-center gap-3 rounded-lg bg-card border border-amber-200 px-3 py-2 shadow-sm">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground">{note.comment || <span className="italic text-muted-foreground">No text</span>}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{formatDateTime(note.created_at)}</p>
                    </div>
                    <button
                      onClick={() => handleDeleteNote(note.id)}
                      disabled={deletingId === note.id}
                      className="flex items-center justify-center text-red-400 hover:text-red-600 cursor-pointer shrink-0 p-1.5 rounded-lg hover:bg-red-50 transition-colors"
                      title="Delete note"
                    >
                      {deletingId === note.id ? (
                        <Loader2 size={24} className="animate-spin" />
                      ) : (
                        <X size={24} />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add note form */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Add a note about this interaction..."
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !submitting && noteText.trim()) handleSubmitNote();
                }}
                className="flex-1 rounded-lg border border-border/60 bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1E8FE8]/30 placeholder:text-muted-foreground/50"
              />

              <button
                onClick={handleSubmitNote}
                disabled={submitting || !noteText.trim()}
                className="rounded-lg bg-[#1E8FE8] px-4 py-2 text-sm font-medium text-[#0f172a] hover:bg-[#1878C8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0 flex items-center gap-1.5"
              >
                {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
                {submitting ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          {/* Timeline */}
          <div className="border-t border-border/30 bg-muted/20 px-5 py-4">
            <div className="relative pl-6">
              <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />

              {thread.events.map((event, i) => {
                const config = EVENT_ICONS[event.event_type] || {
                  icon: <Send size={14} />,
                  color: "text-gray-500 bg-gray-100",
                  label: event.event_type.replace(/_/g, " "),
                };
                const payload = event.payload as Record<string, unknown> | null;
                const replyBody = payload?.reply_body as string | undefined;
                const replySubject = payload?.reply_subject as string | undefined;
                const replyPreview = payload?.reply_preview as string | undefined;
                const hasReplyContent = event.event_type === "email_replied" && (replyBody || replyPreview);

                return (
                  <div key={event.id} className={`relative flex items-start gap-3 ${i < thread.events.length - 1 ? "pb-4" : ""}`}>
                    <div className={`absolute -left-6 flex h-[22px] w-[22px] items-center justify-center rounded-full ${config.color} shrink-0 z-10`}>
                      {config.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{config.label}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(event.received_at)}</p>
                      {hasReplyContent && (
                        <div className="mt-2 rounded-lg bg-card border border-border/60 p-3 shadow-sm">
                          {replySubject && (
                            <p className="text-xs font-semibold text-muted-foreground mb-1">Re: {replySubject}</p>
                          )}
                          <div
                            className="text-sm text-foreground leading-relaxed max-w-none overflow-hidden [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_blockquote]:ml-2 [&_blockquote]:text-muted-foreground [&_blockquote]:text-xs [&_img]:hidden [&_a]:text-[#1E8FE8] [&_a]:underline"
                            dangerouslySetInnerHTML={{
                              __html: formatReplyHtml(replyBody || replyPreview || ""),
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      )}
    </Card>
  );
}

// ===== Main Page =====

export default function ClientRepliesPage() {
  const { userId: ctxUserId, client, campaigns, loading: contextLoading } = useClientData();
  const [threads, setThreads] = useState<LeadThread[]>([]);
  const [filter, setFilter] = useState<"all" | "replied" | "meetings">("all");
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState("");

  useEffect(() => {
    if (contextLoading || !client) return;
    setUserId(ctxUserId);

      // Build maps: instantly_id → name, instantly_id → db UUID
      const campaignNameMap = new Map(campaigns.map((c) => [c.instantly_campaign_id, c.name]));
      const campaignIdMap = new Map(campaigns.map((c) => [c.instantly_campaign_id, c.id]));
      const ids = campaigns.map((c) => c.instantly_campaign_id);
      const dbIds = campaigns.map((c) => c.id);

      const supabase = createClient();
      // Fetch events and existing notes in parallel
      Promise.all([
        supabase
          .from("webhook_events")
          .select("*")
          .in("campaign_instantly_id", ids.length > 0 ? ids : ["none"])
          .in("event_type", ["email_sent", "email_replied", "meeting_booked"])
          .order("received_at", { ascending: true }),
        supabase
          .from("lead_feedback")
          .select("id, campaign_id, lead_email, status, comment, created_at")
          .in("campaign_id", dbIds.length > 0 ? dbIds : ["00000000-0000-0000-0000-000000000000"])
          .order("created_at", { ascending: true }),
      ]).then(([eventsResult, notesResult]) => {

      // Filter out excluded events (admin-excluded leads)
      const events = ((eventsResult.data || []) as WebhookEvent[]).filter((e) => !e.excluded);

      // Build notes map: "email::campaign_instantly_id" → notes[]
      const notesMap = new Map<string, LeadNote[]>();
      const dbIdToInstantlyId = new Map(campaigns.map((c) => [c.id, c.instantly_campaign_id]));
      for (const note of (notesResult.data || []) as { id: string; campaign_id: string; lead_email: string; status: string; comment: string | null; created_at: string }[]) {
        const instantlyId = dbIdToInstantlyId.get(note.campaign_id);
        if (!instantlyId) continue;
        const key = `${note.lead_email}::${instantlyId}`;
        const existing = notesMap.get(key) || [];
        existing.push({ id: note.id, status: note.status, comment: note.comment, created_at: note.created_at });
        notesMap.set(key, existing);
      }

      // Group events by lead email + campaign
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
        const campaignInstantlyId = evts[0]?.campaign_instantly_id || "";
        const campaignName = campaignNameMap.get(campaignInstantlyId) || "Unknown Campaign";
        const campaignId = campaignIdMap.get(campaignInstantlyId) || "";
        const sentEvents = evts.filter((e) => e.event_type === "email_sent");
        const replyEvents = evts.filter((e) => e.event_type === "email_replied");
        const meetingEvents = evts.filter((e) => e.event_type === "meeting_booked");

        // Extract lead name/company from payload
        const anyPayload = evts.find((e) => e.payload)?.payload as Record<string, unknown> | null;
        const leadName = (anyPayload?.first_name as string) || null;
        const leadCompany = (anyPayload?.company_name as string) || null;

        return {
          leadEmail,
          leadName,
          leadCompany,
          campaignName,
          campaignId,
          campaignInstantlyId,
          events: evts,
          firstSent: sentEvents.length > 0 ? sentEvents[0].received_at : null,
          lastReply: replyEvents.length > 0 ? replyEvents[replyEvents.length - 1].received_at : null,
          hasReply: replyEvents.length > 0,
          hasMeeting: meetingEvents.length > 0,
          notes: notesMap.get(key) || [],
        };
      });

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
  }, [contextLoading, client, campaigns, ctxUserId]);

  const handleNoteAdded = useCallback((threadKey: string, note: LeadNote) => {
    setThreads((prev) =>
      prev.map((t) => {
        const key = `${t.leadEmail}::${t.campaignInstantlyId}`;
        if (key === threadKey) {
          return { ...t, notes: [...t.notes, note] };
        }
        return t;
      })
    );
  }, []);

  const handleNoteDeleted = useCallback((threadKey: string, noteId: string) => {
    setThreads((prev) =>
      prev.map((t) => {
        const key = `${t.leadEmail}::${t.campaignInstantlyId}`;
        if (key === threadKey) {
          return { ...t, notes: t.notes.filter((n) => n.id !== noteId) };
        }
        return t;
      })
    );
  }, []);

  if (contextLoading || loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-36 bg-muted/50" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl h-24 bg-muted/50" />
          ))}
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl h-20 bg-muted/50" />
          ))}
        </div>
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
      <div
        className="relative overflow-hidden rounded-[20px] p-7 text-[#0f172a]"
        style={{
          background: "linear-gradient(135deg, #EBF5FE 0%, #D6ECFB 50%, #fff 100%)",
          border: '1px solid rgba(30,143,232,0.2)',
          borderTop: '1px solid rgba(30,143,232,0.3)',
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(30,143,232,0.1)",
        }}
      >
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Campaign Responses</p>
          <h1 className="text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Replies</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">Track lead interactions and add notes for your team</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(71,165,237,0.06)]" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard label="Total Leads" value={threads.length} icon={<Send size={16} className="text-[#1E8FE8]" />} iconBg="bg-[#1E8FE8]/10" />
        <StatCard label="Replied" value={totalReplies} icon={<MailOpen size={16} className="text-blue-500" />} iconBg="bg-blue-50" />
        <StatCard label="Meetings Booked" value={totalMeetings} icon={<CalendarCheck size={16} className="text-emerald-500" />} iconBg="bg-emerald-50" />
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {(
          [
            { key: "all", label: "All Leads", count: threads.length },
            { key: "replied", label: "Replied", count: totalReplies },
            { key: "meetings", label: "Meetings", count: totalMeetings },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              filter === tab.key
                ? "bg-[#1E8FE8]/20 text-[#47A5ED] border border-[#1E8FE8]/20"
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
              <div className="h-12 w-12 rounded-full bg-[#1E8FE8]/10 flex items-center justify-center">
                <MailOpen size={24} className="text-[#1878C8]" />
              </div>
            </div>
            <p className="text-muted-foreground font-medium">No replies yet</p>
            <p className="text-sm text-muted-foreground">Replies will appear here as leads respond to your campaigns.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((thread) => (
            <ThreadCard
              key={`${thread.leadEmail}::${thread.campaignName}`}
              thread={thread}
              userId={userId}
              onNoteAdded={handleNoteAdded}
              onNoteDeleted={handleNoteDeleted}
            />
          ))}
        </div>
      )}
    </div>
  );
}
