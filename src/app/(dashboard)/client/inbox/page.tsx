"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useClientData } from "../client-data-context";
import { PREVIEW_READONLY_MESSAGE } from "@/lib/auth/view-as";
import { appUrl } from "@/lib/api-url";
import { Badge } from "@/components/ui/badge";
import {
  Search,
  Inbox as InboxIcon,
  Phone,
  ExternalLink,
  Clock,
  CheckCircle2,
  Send,
  AlertCircle,
  Mail,
} from "lucide-react";
import type { LeadReply, ReplyClass, ReplyOutcome } from "@/types/app";
import {
  CLASS_META,
  OUTCOME_OPTIONS,
  isReplyActionable,
  timeSince,
  timeSinceShort,
  telHref,
  urgencyColor,
} from "@/lib/replies/ui";
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
import { QuickActionBar, type QuickActionGroup } from "@/components/inbox/quick-action-bar";
import { classAccent } from "@/components/inbox/reclassify-control";

// Classes where the CLIENT may compose a portal follow-up: the genuinely hot,
// call-now classes only (mirrors the old dossier). Referrals/objections/silent
// are worked by the owner, so no composer.
const REPLYABLE_CLASSES: ReplyClass[] = ["true_interest", "meeting_booked", "qualifying_question"];

type Filter = "urgent" | "all" | "resolved";

export default function ClientInboxPage() {
  const { client, loading: contextLoading, noClient } = useClientData();
  const [replies, setReplies] = useState<LeadReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("urgent");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (contextLoading || !client) return;
    const supabase = createClient();
    supabase
      .from("lead_replies")
      .select("*")
      .eq("client_id", client.id)
      .order("received_at", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        setReplies((data || []) as LeadReply[]);
        setLoading(false);
      });
  }, [contextLoading, client]);

  const urgent = useMemo(() => replies.filter(isReplyActionable), [replies]);
  const resolved = useMemo(
    () =>
      replies.filter(
        (r) =>
          r.outcome ||
          r.status === "sent" ||
          r.status === "expired" ||
          r.status === "resolved" ||
          r.status === "rejected",
      ),
    [replies],
  );

  const filtered = useMemo(() => {
    const base = filter === "urgent" ? urgent : filter === "resolved" ? resolved : replies;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((r) =>
      `${r.lead_name ?? ""} ${r.lead_company ?? ""} ${r.lead_email} ${r.body_text ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [filter, urgent, resolved, replies, query]);

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

  const selected = replies.find((r) => r.id === selectedId) ?? null;

  function patchReply(id: string, patch: Partial<LeadReply>) {
    setReplies((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  if (contextLoading || loading) {
    return <div className="h-full min-h-[460px] animate-pulse rounded-2xl bg-muted/50" />;
  }
  if (noClient || !client) {
    return (
      <div className="flex h-64 items-center justify-center text-center">
        <div>
          <p className="font-medium text-muted-foreground">Your account is being set up.</p>
          <p className="text-sm text-muted-foreground">Please check back soon.</p>
        </div>
      </div>
    );
  }

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "urgent", label: "Needs action", count: urgent.length },
    { key: "all", label: "All", count: replies.length },
    { key: "resolved", label: "Resolved", count: resolved.length },
  ];

  return (
    <div className="h-full">
      <Unibox
        hasSelection={!!selectedId}
        list={
          <>
            <UniboxListHeader>
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
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setFilter(t.key)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold transition-colors cursor-pointer ${
                      filter === t.key
                        ? "border-[#2E37FE]/25 bg-[#2E37FE]/[0.13] text-[#2E37FE]"
                        : "border-transparent bg-muted/60 text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {t.label}
                    <span className="tabular-nums opacity-70">{t.count}</span>
                  </button>
                ))}
              </div>
            </UniboxListHeader>
            <UniboxListScroll>
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
                  <InboxIcon size={26} className="opacity-40" />
                  {filter === "urgent" ? "No hot leads waiting" : "No replies here yet"}
                </div>
              ) : (
                filtered.map((r) => {
                  const meta = r.final_class ? CLASS_META[r.final_class] : null;
                  const replied = r.status === "sent" || !!r.outcome;
                  return (
                    <ReplyListRow
                      key={r.id}
                      id={r.id}
                      selected={selectedId === r.id}
                      onClick={() => setSelectedId(r.id)}
                      accent={r.final_class ? classAccent(r.final_class) : "#475569"}
                      monogram={r.lead_name ? initials(r.lead_name) : "🏢"}
                      name={r.lead_name || r.lead_email}
                      sub={[r.lead_company, r.lead_title].filter(Boolean).join(" · ") || undefined}
                      snippet={r.body_text}
                      time={timeSinceShort(r.received_at)}
                      unread={isReplyActionable(r)}
                      badges={
                        <>
                          {meta && (
                            <Badge variant="secondary" className={`${meta.badge} text-[10px]`}>
                              {meta.label}
                            </Badge>
                          )}
                          {replied && (
                            <Badge variant="secondary" className="badge-green text-[9px] inline-flex items-center gap-1">
                              <CheckCircle2 size={9} /> Replied
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
            <ClientThread
              key={selected.id}
              reply={selected}
              onBack={() => setSelectedId(null)}
              onPatch={(patch) => patchReply(selected.id, patch)}
            />
          ) : (
            <ThreadEmpty>Select a reply to see the conversation and respond.</ThreadEmpty>
          )
        }
      />
    </div>
  );
}

function ClientThread({
  reply,
  onBack,
  onPatch,
}: {
  reply: LeadReply;
  onBack: () => void;
  onPatch: (patch: Partial<LeadReply>) => void;
}) {
  // Read-only while an admin previews this portal. Without this the preview
  // could SEND A REAL EMAIL to the lead from the client's mailbox, or log an
  // outcome against their pipeline. See src/lib/auth/view-as.ts.
  const { previewing } = useClientData();
  const isReplyable = reply.final_class ? REPLYABLE_CLASSES.includes(reply.final_class) : false;
  const isSent = reply.status === "sent";
  const phone = telHref(reply.lead_phone_e164);
  const leadName = reply.lead_name || reply.lead_email;

  const [showComposer, setShowComposer] = useState(isReplyable && !isSent);
  const [subject, setSubject] = useState(
    reply.subject ? (reply.subject.startsWith("Re:") ? reply.subject : `Re: ${reply.subject}`) : "",
  );
  const [bodyText, setBodyText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [savingOutcome, setSavingOutcome] = useState<ReplyOutcome | null>(null);
  const [excludeSaving, setExcludeSaving] = useState(false);

  async function send() {
    if (!bodyText.trim() || previewing) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(appUrl(`/api/replies/${reply.id}/send`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim() || undefined, body_text: bodyText }),
      });
      const data = await res.json();
      if (!res.ok) setSendError(data.error || "Failed to send.");
      else onPatch({ status: "sent", sent_at: data.sent_at, final_body_text: bodyText });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setSending(false);
    }
  }

  async function logOutcome(outcome: ReplyOutcome) {
    if (previewing) return;
    setSavingOutcome(outcome);
    try {
      const res = await fetch(appUrl(`/api/replies/${reply.id}/outcome`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      const data = await res.json();
      if (res.ok) onPatch({ outcome, outcome_logged_at: data.outcome_logged_at, status: data.status ?? reply.status });
    } finally {
      setSavingOutcome(null);
    }
  }

  async function toggleExclude() {
    if (previewing) return;
    const next = !reply.excluded_from_stats;
    setExcludeSaving(true);
    try {
      const res = await fetch(appUrl(`/api/replies/${reply.id}/exclude`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: next }),
      });
      if (res.ok) onPatch({ excluded_from_stats: next });
    } finally {
      setExcludeSaving(false);
    }
  }

  const groups: QuickActionGroup[] = [
    {
      label: "Log what happened",
      actions: OUTCOME_OPTIONS.map((opt) => ({
        key: opt.value,
        label: opt.label,
        color: opt.value === "called" ? "#059669" : opt.value === "emailed" ? "#2E37FE" : "#475569",
        active: reply.outcome === opt.value,
        disabled: savingOutcome !== null || previewing,
        onClick: () => logOutcome(opt.value),
      })),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex-none border-b border-border/60 px-4 py-3 sm:px-5">
        <MobileBack onBack={onBack} />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-bold text-foreground">{leadName}</h2>
            {(reply.lead_company || reply.lead_title) && (
              <p className="truncate text-[12.5px] text-muted-foreground">
                {[reply.lead_title, reply.lead_company].filter(Boolean).join(" · ")}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              <a href={`mailto:${reply.lead_email}`} className="inline-flex items-center gap-1 text-[#2E37FE] hover:underline">
                <Mail size={11} /> {reply.lead_email}
              </a>
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
          <div className="flex shrink-0 flex-col gap-1.5">
            {phone && (
              <a
                href={phone}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white"
                style={{ background: "#059669" }}
              >
                <Phone size={12} /> Call
              </a>
            )}
          </div>
        </div>
        {isReplyActionable(reply) && (
          <div
            className="mt-2.5 flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12px]"
            style={{
              background: `${urgencyColor(reply.received_at)}14`,
              border: `1px solid ${urgencyColor(reply.received_at)}33`,
            }}
          >
            <AlertCircle size={13} style={{ color: urgencyColor(reply.received_at) }} />
            <span className="font-semibold" style={{ color: urgencyColor(reply.received_at) }}>
              Received {timeSince(reply.received_at)}.
            </span>
            <span className="text-foreground/70">The faster you respond, the more likely you win.</span>
          </div>
        )}
      </div>

      {/* Quick outcome bar */}
      <QuickActionBar groups={groups} />

      {/* Conversation */}
      <Conversation reply={reply} />

      {/* Referral (if any) */}
      {reply.referral_contact && (
        <div className="flex-none border-t border-border/60 bg-purple-50/60 px-4 py-2.5 text-xs sm:px-5">
          <span className="font-semibold uppercase tracking-wide text-purple-700">Referred contact: </span>
          <span className="font-medium text-foreground">
            {reply.referral_contact.name || reply.referral_contact.email}
          </span>
          {reply.referral_contact.email && (
            <span className="text-purple-700"> · {reply.referral_contact.email}</span>
          )}
        </div>
      )}

      {/* Composer / sent state / footer */}
      <div className="flex-none border-t border-border/60 bg-card px-4 py-3 sm:px-5">
        {isSent ? (
          <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-700">
            <CheckCircle2 size={15} /> Reply sent {reply.sent_at ? timeSince(reply.sent_at) : ""} · CC&apos;d to your inbox.
          </div>
        ) : isReplyable && showComposer ? (
          <div className="space-y-2">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={sending}
              placeholder="Subject"
              className="w-full rounded-lg border border-border/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#2E37FE]/30"
            />
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={3}
              placeholder="Write your reply…"
              disabled={sending}
              className="w-full resize-y rounded-lg border border-border/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#2E37FE]/30"
            />
            {sendError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">{sendError}</div>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">{previewing ? PREVIEW_READONLY_MESSAGE : "Sends from the mailbox they replied to and CCs your inbox."}</p>
              <button
                onClick={send}
                disabled={!bodyText.trim() || sending || previewing}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#2E37FE] px-4 py-2 text-sm font-bold text-white cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send size={14} /> {sending ? "Sending…" : "Send reply"}
              </button>
            </div>
          </div>
        ) : isReplyable ? (
          <button
            onClick={() => setShowComposer(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#2E37FE] px-4 py-2 text-sm font-bold text-white cursor-pointer"
          >
            <Send size={14} /> Reply
          </button>
        ) : (
          <button
            onClick={toggleExclude}
            disabled={excludeSaving || previewing}
            className="text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-50"
          >
            {excludeSaving ? "…" : reply.excluded_from_stats ? "Include in your stats" : "Not a real lead? Exclude from stats"}
          </button>
        )}
      </div>
    </div>
  );
}
