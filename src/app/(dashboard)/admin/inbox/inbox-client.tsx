"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  Inbox as InboxIcon,
  Building2,
  Mail,
  Phone,
  ExternalLink,
  Clock,
  Bot,
  Eye,
  ChevronDown,
} from "lucide-react";
import type { ReplyClass, ReplyOutcome, ReplyStatus, ReplyReferralContact } from "@/types/app";
import {
  CLASS_META,
  OUTCOME_META,
  REPLY_CATEGORIES,
  categoryForClass,
  replySnippet,
  timeSinceShort,
  timeSince,
  telHref,
  type ReplyCategoryKey,
} from "@/lib/replies/ui";
import { appUrl } from "@/lib/api-url";
import {
  Unibox,
  UniboxListHeader,
  UniboxListScroll,
  ReplyListRow,
  ThreadEmpty,
  MobileBack,
  initials,
} from "@/components/inbox/unibox";
import { Conversation } from "@/components/inbox/conversation";
import { QuickActionBar } from "@/components/inbox/quick-action-bar";
import { useReclassifyGroup, classAccent } from "@/components/inbox/reclassify-control";

// Narrowed row shape for the inbox. Columns must match the server component's
// select() — adding a field here without adding it to the query renders undefined.
export interface InboxRowReply {
  id: string;
  client_id: string | null;
  final_class: ReplyClass | null;
  received_at: string;
  lead_email: string;
  lead_name: string | null;
  lead_company: string | null;
  lead_title: string | null;
  lead_phone_e164: string | null;
  lead_linkedin_url: string | null;
  subject: string | null;
  body_text: string | null;
  outcome: ReplyOutcome | null;
  outcome_logged_at: string | null;
  status: ReplyStatus;
  claude_class: ReplyClass | null;
  claude_confidence: number | null;
  claude_reason: string | null;
  keyword_flags: string[] | null;
  referral_contact: ReplyReferralContact | null;
  excluded_from_stats: boolean;
  client: { name: string } | null;
}

type FilterClient = "all" | string;
type FocusCategory = "all" | ReplyCategoryKey;

function rowAccent(cls: ReplyClass | null): string {
  return cls ? classAccent(cls) : "#475569";
}

export function InboxClient({ replies }: { replies: InboxRowReply[] }) {
  // Local mutable copy so a retag / exclude updates the row in place without a refetch.
  const [rows, setRows] = useState<InboxRowReply[]>(replies);
  useEffect(() => setRows(replies), [replies]);

  const [filterClient, setFilterClient] = useState<FilterClient>("all");
  const [focus, setFocus] = useState<FocusCategory>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const clientOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.client_id && !seen.has(r.client_id) && r.client?.name) seen.set(r.client_id, r.client.name);
    }
    return Array.from(seen.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const clientScoped = useMemo(
    () => (filterClient === "all" ? rows : rows.filter((r) => r.client_id === filterClient)),
    [rows, filterClient],
  );

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: clientScoped.length };
    for (const c of REPLY_CATEGORIES) m[c.key] = 0;
    for (const r of clientScoped) m[categoryForClass(r.final_class)]++;
    return m;
  }, [clientScoped]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clientScoped.filter((r) => {
      if (focus !== "all" && categoryForClass(r.final_class) !== focus) return false;
      if (q) {
        const hay = `${r.lead_name ?? ""} ${r.lead_company ?? ""} ${r.lead_email} ${r.body_text ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [clientScoped, focus, query]);

  // Track desktop vs mobile with a live listener (a one-shot matchMedia at
  // mount races the first paint). Auto-open the first reply on desktop so the
  // pane isn't empty; never on mobile (that would hide the list on load).
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (isDesktop && !selectedId && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [isDesktop, filtered, selectedId]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  function handleRetag(cls: ReplyClass) {
    setRows((prev) =>
      prev.map((r) =>
        r.id === selectedId
          ? { ...r, final_class: cls, status: r.status === "new" ? "classified" : r.status }
          : r,
      ),
    );
  }
  function handleExclude(excluded: boolean) {
    setRows((prev) => prev.map((r) => (r.id === selectedId ? { ...r, excluded_from_stats: excluded } : r)));
  }

  return (
    <div className="h-full">
      <Unibox
        hasSelection={!!selectedId}
        list={
          <>
            <UniboxListHeader>
              <div className="flex items-center gap-2">
                <Select value={filterClient} onValueChange={(v) => setFilterClient((v as FilterClient) || "all")}>
                  <SelectTrigger className="h-8 flex-1 text-xs font-medium">
                    <SelectValue>
                      {(value) =>
                        typeof value !== "string" || !value || value === "all"
                          ? "All clients"
                          : clientOptions.find((c) => c.id === value)?.name ?? value
                      }
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
              </div>
              <div className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 h-8">
                <Search size={13} className="text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search replies…"
                  className="w-full bg-transparent text-[12.5px] outline-none"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <CategoryPill active={focus === "all"} onClick={() => setFocus("all")} label="All" count={counts.all} />
                {REPLY_CATEGORIES.map((cat) => (
                  <CategoryPill
                    key={cat.key}
                    active={focus === cat.key}
                    onClick={() => setFocus(cat.key)}
                    label={cat.label.split(":")[0]}
                    count={counts[cat.key]}
                    dot={CAT_COLOR[cat.key]}
                  />
                ))}
              </div>
            </UniboxListHeader>

            <UniboxListScroll>
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
                  <InboxIcon size={26} className="opacity-40" />
                  No replies match these filters
                </div>
              ) : (
                filtered.map((r) => {
                  const meta = r.final_class ? CLASS_META[r.final_class] : null;
                  return (
                    <ReplyListRow
                      key={r.id}
                      id={r.id}
                      selected={selectedId === r.id}
                      onClick={() => setSelectedId(r.id)}
                      accent={rowAccent(r.final_class)}
                      monogram={initials(r.lead_name || r.lead_email)}
                      name={r.lead_name || r.lead_email}
                      sub={`${r.client?.name || "—"}${r.lead_company ? ` · ${r.lead_company}` : ""}`}
                      snippet={replySnippet(r.body_text, r.subject)}
                      time={timeSinceShort(r.received_at)}
                      badges={
                        <>
                          {meta && (
                            <Badge variant="secondary" className={`${meta.badge} text-[10px]`}>
                              {meta.label}
                            </Badge>
                          )}
                          {r.outcome && (
                            <Badge variant="secondary" className="badge-slate text-[9px]">
                              {r.outcome.replace(/_/g, " ")}
                            </Badge>
                          )}
                        </>
                      }
                    />
                  );
                })
              )}
            </UniboxListScroll>
          </>
        }
        detail={
          selected ? (
            <AdminThread
              key={selected.id}
              reply={selected}
              onBack={() => setSelectedId(null)}
              onRetag={handleRetag}
              onExclude={handleExclude}
            />
          ) : (
            <ThreadEmpty />
          )
        }
      />
    </div>
  );
}

const CAT_COLOR: Record<ReplyCategoryKey, string> = {
  hot: "#2E37FE",
  referral: "#7c3aed",
  objection: "#d97706",
  review: "#d97706",
  silent: "#475569",
};

function CategoryPill({
  active,
  onClick,
  label,
  count,
  dot,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  dot?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold transition-colors cursor-pointer ${
        active
          ? "border-[#2E37FE]/25 bg-[#2E37FE]/[0.13] text-[#2E37FE]"
          : "border-transparent bg-muted/60 text-muted-foreground hover:bg-muted"
      }`}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />}
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function AdminThread({
  reply,
  onBack,
  onRetag,
  onExclude,
}: {
  reply: InboxRowReply;
  onBack: () => void;
  onRetag: (cls: ReplyClass) => void;
  onExclude: (excluded: boolean) => void;
}) {
  const { group } = useReclassifyGroup({
    replyId: reply.id,
    currentClass: reply.final_class,
    onChanged: onRetag,
  });
  const meta = reply.final_class ? CLASS_META[reply.final_class] : null;
  const outcomeMeta = reply.outcome ? OUTCOME_META[reply.outcome] : null;
  const phone = telHref(reply.lead_phone_e164);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex-none border-b border-border/60 px-4 py-3 sm:px-5">
        <MobileBack onBack={onBack} />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[17px] font-bold text-foreground">
                {reply.lead_name || reply.lead_email}
              </h2>
              {meta && (
                <Badge variant="secondary" className={`${meta.badge} text-[10px] shrink-0`}>
                  {meta.label}
                </Badge>
              )}
              {outcomeMeta && (
                <Badge variant="secondary" className="badge-slate text-[9px] shrink-0">
                  ✓ {outcomeMeta.label}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-muted-foreground">
              {reply.lead_company && (
                <span className="inline-flex items-center gap-1">
                  <Building2 size={12} /> {reply.lead_company}
                  {reply.lead_title ? ` · ${reply.lead_title}` : ""}
                </span>
              )}
              <span>
                Client: <span className="font-medium text-foreground/80">{reply.client?.name ?? "—"}</span>
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              <a href={`mailto:${reply.lead_email}`} className="inline-flex items-center gap-1 text-[#2E37FE] hover:underline">
                <Mail size={11} /> {reply.lead_email}
              </a>
              {phone && (
                <a href={phone} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                  <Phone size={11} /> {reply.lead_phone_e164}
                </a>
              )}
              {reply.lead_linkedin_url && (
                <a
                  href={reply.lead_linkedin_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[#0077b5] hover:underline"
                >
                  LinkedIn <ExternalLink size={11} />
                </a>
              )}
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Clock size={11} /> {timeSince(reply.received_at)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Quick reclassify bar */}
      <QuickActionBar groups={[group]} />

      {/* Admin view banner */}
      <div className="flex flex-none items-center gap-2 bg-slate-100 px-4 py-1.5 text-[11px] text-slate-600 sm:px-5">
        <Eye size={12} /> Admin view — retagging here corrects the classifier and does not re-notify the client.
      </div>

      {/* Conversation */}
      <Conversation reply={reply} />

      {/* Classification trail + exclude (collapsible footer) */}
      <TrailFooter reply={reply} onExclude={onExclude} />
    </div>
  );
}

function TrailFooter({ reply, onExclude }: { reply: InboxRowReply; onExclude: (v: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  async function toggleExclude() {
    const next = !reply.excluded_from_stats;
    setSaving(true);
    try {
      const res = await fetch(appUrl(`/api/replies/${reply.id}/exclude`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: next }),
      });
      if (res.ok) onExclude(next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex-none border-t border-border/60 bg-card">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/40 cursor-pointer sm:px-5"
      >
        <Bot size={13} className="text-[#2E37FE]" /> Classification trail
        <ChevronDown size={13} className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2.5 px-4 pb-3 text-xs sm:px-5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            <div>
              <p className="text-muted-foreground">Claude class</p>
              <p className="font-medium text-foreground">
                {reply.claude_class ? CLASS_META[reply.claude_class].label : "—"}
                {reply.claude_confidence != null && (
                  <span className="text-muted-foreground"> · {Math.round(reply.claude_confidence * 100)}%</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Keyword flags</p>
              <p className="font-medium text-foreground">
                {reply.keyword_flags && reply.keyword_flags.length > 0 ? reply.keyword_flags.join(", ") : "—"}
              </p>
            </div>
          </div>
          {reply.claude_reason && (
            <p className="border-t border-border/50 pt-2 italic text-muted-foreground">
              &ldquo;{reply.claude_reason}&rdquo;
            </p>
          )}
          {reply.referral_contact && (
            <div className="border-t border-border/50 pt-2">
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Extracted referral
              </p>
              <p className="font-medium text-foreground">
                {reply.referral_contact.name || reply.referral_contact.email}
                {reply.referral_contact.title && (
                  <span className="font-normal text-muted-foreground"> — {reply.referral_contact.title}</span>
                )}
              </p>
              {reply.referral_contact.email && (
                <p className="text-muted-foreground">{reply.referral_contact.email}</p>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-2">
            <span className="text-muted-foreground">
              {reply.excluded_from_stats ? "Excluded from client stats" : "Counted in client stats"}
            </span>
            <button
              onClick={toggleExclude}
              disabled={saving}
              className="rounded-lg border border-border bg-white px-2.5 py-1 text-[11px] font-semibold hover:bg-muted cursor-pointer disabled:opacity-50"
            >
              {saving ? "…" : reply.excluded_from_stats ? "Include" : "Exclude"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
