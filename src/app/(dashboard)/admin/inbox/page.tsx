"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Inbox as InboxIcon,
  Phone,
  Clock,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import type { LeadReply, ReplyClass } from "@/types/app";
import { CLASS_META, isReplyActionable, timeSinceShort } from "@/lib/replies/ui";

// Joined shape: lead_replies.* + { client: { name } }
interface AdminReply extends LeadReply {
  client?: { name: string } | null;
}

type FilterClient = "all" | string; // client_id
type FilterClass = "all" | "hot" | "needs_review" | "silent" | ReplyClass;

export default function AdminInboxPage() {
  const [replies, setReplies] = useState<AdminReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterClient, setFilterClient] = useState<FilterClient>("all");
  const [filterClass, setFilterClass] = useState<FilterClass>("hot");

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("lead_replies")
      .select("*, client:client_id(name)")
      .order("received_at", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        setReplies((data || []) as AdminReply[]);
        setLoading(false);
      });
  }, []);

  // Derive the client dropdown from whatever clients have replies.
  // Orphan replies (client_id IS NULL) don't contribute a dropdown entry —
  // they surface under the "all" filter and in B3's triage UI.
  const clientOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of replies) {
      if (!r.client_id) continue;
      if (!seen.has(r.client_id) && r.client?.name) {
        seen.set(r.client_id, r.client.name);
      }
    }
    return Array.from(seen.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [replies]);

  const filtered = useMemo(() => {
    return replies.filter((r) => {
      if (filterClient !== "all" && r.client_id !== filterClient) return false;
      if (filterClass === "all") return true;
      if (filterClass === "hot") return r.final_class && CLASS_META[r.final_class]?.urgent;
      if (filterClass === "needs_review") return r.final_class === "needs_review";
      if (filterClass === "silent") {
        return (
          r.final_class &&
          !CLASS_META[r.final_class].urgent &&
          r.final_class !== "needs_review"
        );
      }
      return r.final_class === filterClass;
    });
  }, [replies, filterClient, filterClass]);

  // Stats
  const totalHot = replies.filter(
    (r) => r.final_class && CLASS_META[r.final_class].urgent
  ).length;
  const needsReview = replies.filter((r) => r.final_class === "needs_review").length;
  const unresolved1h = replies.filter((r) => {
    return (
      isReplyActionable(r) &&
      Date.now() - new Date(r.received_at).getTime() > 60 * 60 * 1000
    );
  }).length;
  const resolvedToday = replies.filter((r) => {
    if (!r.outcome_logged_at) return false;
    return Date.now() - new Date(r.outcome_logged_at).getTime() < 24 * 60 * 60 * 1000;
  }).length;

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-28 bg-muted/50" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl h-24 bg-muted/50" />
          ))}
        </div>
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl h-16 bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

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
          <p className="text-xs font-medium text-[#64748b]">Reply Routing</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ letterSpacing: "-0.01em" }}>
            Inbox Oversight
          </h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            Every classified reply across all clients. Clients act; you observe, coach, and reclassify misses.
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="Total hot"
          value={totalHot}
          icon={<Phone size={16} className="text-[#2E37FE]" />}
          iconBg="bg-[#2E37FE]/10"
        />
        <StatCard
          label="Resolved today"
          value={resolvedToday}
          icon={<CheckCircle2 size={16} className="text-emerald-500" />}
          iconBg="bg-emerald-50"
        />
        <StatCard
          label="Unresolved > 1h"
          value={unresolved1h}
          icon={<AlertTriangle size={16} className="text-red-500" />}
          iconBg="bg-red-50"
        />
        <StatCard
          label="Needs review"
          value={needsReview}
          icon={<InboxIcon size={16} className="text-amber-500" />}
          iconBg="bg-amber-50"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <Select value={filterClient} onValueChange={(v) => setFilterClient((v as FilterClient) || "all")}>
          <SelectTrigger className="h-9 w-[200px] text-xs font-medium">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All clients</SelectItem>
            {clientOptions.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterClass} onValueChange={(v) => setFilterClass((v as FilterClass) || "hot")}>
          <SelectTrigger className="h-9 w-[180px] text-xs font-medium">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hot">Hot only</SelectItem>
            <SelectItem value="all">All classes</SelectItem>
            <SelectItem value="needs_review">Needs review</SelectItem>
            <SelectItem value="silent">Silent (OOO, wrong, etc.)</SelectItem>
            <SelectItem value="true_interest">Interested</SelectItem>
            <SelectItem value="meeting_booked">Meeting Booked</SelectItem>
            <SelectItem value="qualifying_question">Has Question</SelectItem>
            <SelectItem value="referral_forward">Referral</SelectItem>
            <SelectItem value="objection_price">Price Concern</SelectItem>
            <SelectItem value="objection_timing">Timing Concern</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-1">{filtered.length} shown</span>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <div className="flex justify-center mb-3">
              <div className="h-12 w-12 rounded-full bg-[#2E37FE] flex items-center justify-center">
                <InboxIcon size={24} className="text-white" />
              </div>
            </div>
            <p className="text-muted-foreground font-medium">No replies match this filter</p>
            <p className="text-sm text-muted-foreground">Try loosening the filter or waiting for fresh data.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((reply) => {
            const meta = reply.final_class ? CLASS_META[reply.final_class] : null;
            const minutesOld = Math.floor(
              (Date.now() - new Date(reply.received_at).getTime()) / 60000
            );
            const isStale = isReplyActionable(reply) && minutesOld > 60;

            return (
              <Link key={reply.id} href={`/admin/inbox/${reply.id}`} className="block group">
                <Card className="border-border/50 shadow-sm transition-all group-hover:border-[#2E37FE]/30">
                  <CardContent className="flex items-center gap-4 px-4 py-3">
                    {/* Class dot */}
                    <div
                      className={`flex h-8 w-8 items-center justify-center rounded-full shrink-0 ${
                        meta?.urgent
                          ? "bg-[#2E37FE]/10 text-[#2E37FE]"
                          : reply.final_class === "needs_review"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {meta?.urgent ? (
                        <Phone size={14} />
                      ) : reply.final_class === "needs_review" ? (
                        <AlertTriangle size={14} />
                      ) : (
                        <InboxIcon size={14} />
                      )}
                    </div>

                    {/* Client */}
                    <div className="w-32 shrink-0 hidden md:block">
                      <p className="text-xs text-muted-foreground truncate">
                        {reply.client?.name || "—"}
                      </p>
                    </div>

                    {/* Lead */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm truncate">
                          {reply.lead_name || reply.lead_email}
                        </p>
                        {isStale && (
                          <Badge variant="secondary" className="badge-red text-[9px] shrink-0">
                            stale
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
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

                    {/* Outcome */}
                    <div className="shrink-0 w-16 text-right hidden lg:block">
                      {reply.outcome ? (
                        <Badge variant="secondary" className="badge-slate text-[9px]">
                          {reply.outcome.replace(/_/g, " ")}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>

                    {/* Age */}
                    <div className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground w-12 justify-end">
                      <Clock size={10} />
                      <span>{timeSinceShort(reply.received_at)}</span>
                    </div>

                    <ArrowRight size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
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
