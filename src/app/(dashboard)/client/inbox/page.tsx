"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useClientData } from "../client-data-context";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import { Inbox as InboxIcon, Phone, Clock, ArrowRight, AlertCircle } from "lucide-react";
import type { LeadReply } from "@/types/app";
import { CLASS_META, timeSince } from "@/lib/replies/ui";

// ===== Page =====

export default function ClientInboxPage() {
  const { client, loading: contextLoading, noClient } = useClientData();
  const [replies, setReplies] = useState<LeadReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"urgent" | "all">("urgent");

  useEffect(() => {
    if (contextLoading || !client) return;
    const supabase = createClient();
    supabase
      .from("lead_replies")
      .select("*")
      .eq("client_id", client.id)
      .order("received_at", { ascending: false })
      .then(({ data }) => {
        setReplies((data || []) as LeadReply[]);
        setLoading(false);
      });
  }, [contextLoading, client]);

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
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl h-20 bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  if (noClient || !client) {
    return (
      <div className="flex items-center justify-center h-64 text-center">
        <div>
          <p className="text-muted-foreground font-medium">Your account is being set up.</p>
          <p className="text-sm text-muted-foreground">Please check back soon.</p>
        </div>
      </div>
    );
  }

  const urgentReplies = replies.filter(
    (r) => r.final_class && CLASS_META[r.final_class]?.urgent && !r.outcome
  );
  const totalHot = replies.filter((r) => r.final_class && CLASS_META[r.final_class]?.urgent).length;
  const resolvedToday = replies.filter((r) => {
    if (!r.outcome_logged_at) return false;
    const diff = Date.now() - new Date(r.outcome_logged_at).getTime();
    return diff < 24 * 60 * 60 * 1000;
  }).length;
  const unresolvedOverHour = urgentReplies.filter(
    (r) => Date.now() - new Date(r.received_at).getTime() > 60 * 60 * 1000
  ).length;

  const shown = filter === "urgent" ? urgentReplies : replies;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div
        className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]"
        style={{
          background: "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: "1px solid rgba(46,55,254,0.2)",
          borderTop: "1px solid rgba(46,55,254,0.3)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
        }}
      >
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Hot Leads</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ letterSpacing: "-0.01em" }}>
            Inbox
          </h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            Pick up the phone and call them — the first 5 minutes matter most.
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard
          label="Waiting for you"
          value={urgentReplies.length}
          icon={<InboxIcon size={16} className="text-[#2E37FE]" />}
          iconBg="bg-[#2E37FE]/10"
        />
        <StatCard
          label="Resolved today"
          value={resolvedToday}
          icon={<Phone size={16} className="text-emerald-500" />}
          iconBg="bg-emerald-50"
        />
        <StatCard
          label="Over 1 hour old"
          value={unresolvedOverHour}
          icon={<AlertCircle size={16} className="text-red-500" />}
          iconBg="bg-red-50"
        />
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {([
          { key: "urgent", label: "Needs action", count: urgentReplies.length },
          { key: "all", label: "All", count: replies.length },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              filter === tab.key
                ? "bg-[#2E37FE]/20 text-[#6B72FF] border border-[#2E37FE]/20"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      {/* List */}
      {shown.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <div className="flex justify-center mb-3">
              <div className="h-12 w-12 rounded-full bg-[#2E37FE] flex items-center justify-center">
                <InboxIcon size={24} className="text-white" />
              </div>
            </div>
            <p className="text-muted-foreground font-medium">
              {filter === "urgent" ? "No hot leads waiting" : "No replies yet"}
            </p>
            <p className="text-sm text-muted-foreground">
              {filter === "urgent"
                ? "Keep your phone close — we'll ping you the moment one lands."
                : "Replies to your campaigns will show up here as they come in."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((reply) => {
            const meta = reply.final_class ? CLASS_META[reply.final_class] : null;
            const isOverHour =
              meta?.urgent &&
              !reply.outcome &&
              Date.now() - new Date(reply.received_at).getTime() > 60 * 60 * 1000;

            return (
              <Link
                key={reply.id}
                href={`/client/inbox/${reply.id}`}
                className="block group"
              >
                <Card className="border-border/50 shadow-sm transition-all group-hover:border-[#2E37FE]/30">
                  <CardContent className="flex items-center gap-4 px-5 py-4">
                    {/* Class indicator */}
                    <div
                      className={`flex h-10 w-10 items-center justify-center rounded-full shrink-0 ${
                        meta?.urgent ? "bg-[#2E37FE]/10 text-[#2E37FE]" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {meta?.urgent ? <Phone size={18} /> : <InboxIcon size={18} />}
                    </div>

                    {/* Lead info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm truncate">
                          {reply.lead_name || reply.lead_email}
                        </p>
                        {isOverHour && (
                          <Badge variant="secondary" className="badge-red text-[9px] shrink-0">
                            {"> 1h"}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {reply.lead_company}
                        {reply.lead_title && <span> · {reply.lead_title}</span>}
                      </p>
                    </div>

                    {/* Class badge */}
                    <div className="shrink-0 hidden sm:block">
                      {meta && (
                        <Badge variant="secondary" className={`${meta.badge} text-[10px]`}>
                          {meta.label}
                        </Badge>
                      )}
                    </div>

                    {/* Time */}
                    <div className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground w-20 justify-end">
                      <Clock size={12} />
                      <span>{timeSince(reply.received_at)}</span>
                    </div>

                    {/* Outcome / arrow */}
                    <div className="shrink-0 w-6 flex justify-end">
                      {reply.outcome ? (
                        <Badge variant="secondary" className="badge-slate text-[9px]">
                          ✓
                        </Badge>
                      ) : (
                        <ArrowRight size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100" />
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
