"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import { PaginationControls } from "@/components/ui/pagination-controls";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Inbox as InboxIcon,
  Phone,
  Clock,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  MessageSquare,
  Archive,
} from "lucide-react";
import type { ReplyClass, ReplyOutcome, ReplyStatus } from "@/types/app";
import {
  CLASS_META,
  REPLY_CATEGORIES,
  categoryForClass,
  replySnippet,
  isReplyActionable,
  timeSinceShort,
  type ReplyCategoryKey,
} from "@/lib/replies/ui";

// Narrowed row shape for the inbox list. Columns must match the server
// component's select() — adding a field here without adding it to the
// query would silently render `undefined`.
export interface InboxRowReply {
  id: string;
  client_id: string | null;
  final_class: ReplyClass | null;
  received_at: string;
  lead_email: string;
  lead_name: string | null;
  lead_company: string | null;
  lead_title: string | null;
  subject: string | null;
  body_text: string | null;
  outcome: ReplyOutcome | null;
  outcome_logged_at: string | null;
  status: ReplyStatus;
  client: { name: string } | null;
}

type FilterClient = "all" | string;
type FocusCategory = "all" | ReplyCategoryKey;

const INBOX_PAGE_SIZE = 25;
// How many rows to preview per category when showing every section at once.
const SECTION_PREVIEW = 6;

// Per-category icon + accent for section headers and row dots.
const CATEGORY_UI: Record<
  ReplyCategoryKey,
  { icon: ReactNode; dot: string; ring: string }
> = {
  hot: {
    icon: <Phone size={14} />,
    dot: "bg-[#2E37FE]/10 text-[#2E37FE]",
    ring: "text-[#2E37FE]",
  },
  objection: {
    icon: <MessageSquare size={14} />,
    dot: "bg-amber-100 text-amber-700",
    ring: "text-amber-600",
  },
  review: {
    icon: <AlertTriangle size={14} />,
    dot: "bg-amber-100 text-amber-700",
    ring: "text-amber-600",
  },
  silent: {
    icon: <Archive size={14} />,
    dot: "bg-muted text-muted-foreground",
    ring: "text-muted-foreground",
  },
};

export function InboxClient({ replies }: { replies: InboxRowReply[] }) {
  const [filterClient, setFilterClient] = useState<FilterClient>("all");
  const [focus, setFocus] = useState<FocusCategory>("all");
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [filterClient, focus]);

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

  // Everything downstream (stats, sections, counts) reflects the client filter.
  const scoped = useMemo(
    () =>
      filterClient === "all"
        ? replies
        : replies.filter((r) => r.client_id === filterClient),
    [replies, filterClient],
  );

  // Group the scoped replies by category, preserving the server's
  // newest-first order within each bucket.
  const byCategory = useMemo(() => {
    const map: Record<ReplyCategoryKey, InboxRowReply[]> = {
      hot: [],
      objection: [],
      review: [],
      silent: [],
    };
    for (const r of scoped) map[categoryForClass(r.final_class)].push(r);
    return map;
  }, [scoped]);

  const totalHot = byCategory.hot.length;
  const needsReview = byCategory.review.length;
  const unresolved1h = scoped.filter(
    (r) =>
      isReplyActionable(r) &&
      Date.now() - new Date(r.received_at).getTime() > 60 * 60 * 1000,
  ).length;
  const resolvedToday = scoped.filter(
    (r) =>
      r.outcome_logged_at &&
      Date.now() - new Date(r.outcome_logged_at).getTime() < 24 * 60 * 60 * 1000,
  ).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div
        className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]"
        style={{
          background:
            "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: "1px solid rgba(46,55,254,0.2)",
          borderTop: "1px solid rgba(46,55,254,0.3)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
        }}
      >
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Reply Routing</p>
          <h1
            className="text-[20px] sm:text-[22px] font-bold mt-1"
            style={{ letterSpacing: "-0.01em" }}
          >
            Inbox Oversight
          </h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            Every inbound reply across all clients, grouped by what it needs.
            Clients act; you observe, coach, and reclassify misses.
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

      {/* Filters: client + category pills */}
      <div className="flex flex-wrap gap-2 items-center">
        <Select
          value={filterClient}
          onValueChange={(v) => setFilterClient((v as FilterClient) || "all")}
        >
          <SelectTrigger className="h-9 w-[200px] text-xs font-medium">
            <SelectValue>
              {(value) => {
                if (typeof value !== "string" || !value || value === "all")
                  return "All clients";
                return clientOptions.find((c) => c.id === value)?.name ?? value;
              }}
            </SelectValue>
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

        <div className="flex flex-wrap gap-1.5">
          <CategoryPill
            active={focus === "all"}
            onClick={() => setFocus("all")}
            label="All"
            count={scoped.length}
          />
          {REPLY_CATEGORIES.map((cat) => (
            <CategoryPill
              key={cat.key}
              active={focus === cat.key}
              onClick={() => setFocus(cat.key)}
              label={cat.label}
              count={byCategory[cat.key].length}
            />
          ))}
        </div>
      </div>

      {/* List */}
      {scoped.length === 0 ? (
        <EmptyState />
      ) : focus === "all" ? (
        // Segmented overview: every non-empty category as its own section.
        <div className="space-y-7">
          {REPLY_CATEGORIES.filter((c) => byCategory[c.key].length > 0).map(
            (cat) => {
              const rows = byCategory[cat.key];
              const preview = rows.slice(0, SECTION_PREVIEW);
              return (
                <section key={cat.key} className="space-y-2">
                  <SectionHeader
                    categoryKey={cat.key}
                    label={cat.label}
                    blurb={cat.blurb}
                    count={rows.length}
                    onViewAll={
                      rows.length > SECTION_PREVIEW
                        ? () => setFocus(cat.key)
                        : undefined
                    }
                  />
                  {preview.map((reply) => (
                    <ReplyRow key={reply.id} reply={reply} />
                  ))}
                  {rows.length > SECTION_PREVIEW && (
                    <button
                      onClick={() => setFocus(cat.key)}
                      className="text-xs font-medium text-[#2E37FE] hover:underline cursor-pointer pl-1"
                    >
                      View all {rows.length} →
                    </button>
                  )}
                </section>
              );
            },
          )}
        </div>
      ) : (
        // Focused category: flat, paginated.
        <FocusedList
          rows={byCategory[focus]}
          categoryKey={focus}
          page={page}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}

function CategoryPill({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer border ${
        active
          ? "bg-[#2E37FE]/15 text-[#2E37FE] border-[#2E37FE]/25"
          : "bg-muted/50 text-muted-foreground border-transparent hover:bg-muted"
      }`}
    >
      {label}
      <span
        className={`tabular-nums ${active ? "text-[#2E37FE]" : "text-muted-foreground/70"}`}
      >
        {count}
      </span>
    </button>
  );
}

function SectionHeader({
  categoryKey,
  label,
  blurb,
  count,
  onViewAll,
}: {
  categoryKey: ReplyCategoryKey;
  label: string;
  blurb: string;
  count: number;
  onViewAll?: () => void;
}) {
  const ui = CATEGORY_UI[categoryKey];
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`shrink-0 ${ui.ring}`}>{ui.icon}</span>
        <h2 className="text-sm font-bold text-foreground">{label}</h2>
        <Badge variant="secondary" className="badge-slate text-[10px] shrink-0">
          {count}
        </Badge>
        <span className="text-xs text-muted-foreground truncate hidden sm:inline">
          · {blurb}
        </span>
      </div>
      {onViewAll && (
        <button
          onClick={onViewAll}
          className="text-xs font-medium text-[#2E37FE] hover:underline cursor-pointer shrink-0"
        >
          View all →
        </button>
      )}
    </div>
  );
}

function FocusedList({
  rows,
  categoryKey,
  page,
  onPageChange,
}: {
  rows: InboxRowReply[];
  categoryKey: ReplyCategoryKey;
  page: number;
  onPageChange: (p: number) => void;
}) {
  const cat = REPLY_CATEGORIES.find((c) => c.key === categoryKey)!;
  const totalPages = Math.max(1, Math.ceil(rows.length / INBOX_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * INBOX_PAGE_SIZE;
  const pageRows = rows.slice(start, start + INBOX_PAGE_SIZE);

  return (
    <div className="space-y-2">
      <SectionHeader
        categoryKey={categoryKey}
        label={cat.label}
        blurb={cat.blurb}
        count={rows.length}
      />
      {pageRows.map((reply) => (
        <ReplyRow key={reply.id} reply={reply} />
      ))}
      <PaginationControls
        currentPage={safePage}
        totalItems={rows.length}
        pageSize={INBOX_PAGE_SIZE}
        onPageChange={onPageChange}
      />
    </div>
  );
}

function ReplyRow({ reply }: { reply: InboxRowReply }) {
  const meta = reply.final_class ? CLASS_META[reply.final_class] : null;
  const catUi = CATEGORY_UI[categoryForClass(reply.final_class)];
  const minutesOld = Math.floor(
    (Date.now() - new Date(reply.received_at).getTime()) / 60000,
  );
  const isStale = isReplyActionable(reply) && minutesOld > 60;
  const snippet = replySnippet(reply.body_text, reply.subject);

  return (
    <Link href={`/admin/inbox/${reply.id}`} className="block group">
      <Card className="border-border/50 shadow-sm transition-all group-hover:border-[#2E37FE]/30">
        <CardContent className="flex items-start gap-4 px-4 py-3">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full shrink-0 mt-0.5 ${catUi.dot}`}
          >
            {catUi.icon}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium text-sm truncate">
                {reply.lead_name || reply.lead_email}
              </p>
              {isStale && (
                <Badge
                  variant="secondary"
                  className="badge-red text-[9px] shrink-0"
                >
                  stale
                </Badge>
              )}
              {meta && (
                <Badge
                  variant="secondary"
                  className={`${meta.badge} text-[10px] shrink-0 hidden sm:inline-flex`}
                >
                  {meta.label}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {reply.client?.name || "—"}
              {reply.lead_company && <span> · {reply.lead_company}</span>}
              {reply.lead_title && <span> · {reply.lead_title}</span>}
            </p>
            {snippet && (
              <p className="text-sm text-muted-foreground/90 truncate mt-1">
                {snippet}
              </p>
            )}
          </div>

          <div className="shrink-0 w-16 text-right hidden lg:block">
            {reply.outcome ? (
              <Badge variant="secondary" className="badge-slate text-[9px]">
                {reply.outcome.replace(/_/g, " ")}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>

          <div className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground w-12 justify-end mt-0.5">
            <Clock size={10} />
            <span>{timeSinceShort(reply.received_at)}</span>
          </div>

          <ArrowRight
            size={14}
            className="text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0 mt-1"
          />
        </CardContent>
      </Card>
    </Link>
  );
}

function EmptyState() {
  return (
    <Card className="border-border/50 shadow-sm">
      <CardContent className="py-12 text-center">
        <div className="flex justify-center mb-3">
          <div className="h-12 w-12 rounded-full bg-[#2E37FE] flex items-center justify-center">
            <InboxIcon size={24} className="text-white" />
          </div>
        </div>
        <p className="text-muted-foreground font-medium">No replies yet</p>
        <p className="text-sm text-muted-foreground">
          Inbound replies to your campaigns will show up here as they land.
        </p>
      </CardContent>
    </Card>
  );
}
