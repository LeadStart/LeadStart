"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { appUrl } from "@/lib/api-url";
import { useClientData } from "../../client-data-context";
import { Card, CardContent } from "@/components/ui/card";
import {
  ChevronLeft,
  ExternalLink,
  AlertCircle,
  Clock,
  CheckCircle2,
  Send,
} from "lucide-react";
import type { LeadReply, ReplyClass, ReplyOutcome } from "@/types/app";
import {
  OUTCOME_OPTIONS,
  isReplyActionable,
  timeSince,
  telHref,
  formatBody,
  urgencyColor,
} from "@/lib/replies/ui";

// Classes where the client might want to send a follow-up email via the
// portal. Silent classes (ooo, unsubscribe, not_interested,
// wrong_person_no_referral) don't need a composer.
const REPLYABLE_CLASSES: ReplyClass[] = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
  "objection_price",
  "objection_timing",
  "referral_forward",
];

// Brand gradients (inline — custom gradient classes don't reliably generate
// under Tailwind v4, per project convention).
const GRAD = "linear-gradient(135deg, #6B72FF 0%, #2E37FE 30%, #1C24B8 65%, #0F1880 100%)";
const GREEN = "linear-gradient(135deg, #10b981 0%, #059669 100%)";
const BLUE = "linear-gradient(135deg, #2AA4E4 0%, #0A66C2 60%, #044A82 100%)";
const SLATE = "linear-gradient(135deg, #8b93b8 0%, #5b6486 100%)";

// Monogram from a person's name ("Sarah Chen" → "SC").
function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "•";
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

// Absolute timestamp in the viewer's own timezone. Safe to format inline here
// because this page loads its reply client-side, so the timestamp only ever
// renders in the browser (no SSR → no hydration mismatch).
function formatReceived(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

// ===== Page =====

export default function ReplyDossierPage() {
  const { id } = useParams<{ id: string }>();
  const { client, loading: contextLoading } = useClientData();

  const [reply, setReply] = useState<LeadReply | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Outcome UI state
  const [outcomeValue, setOutcomeValue] = useState<ReplyOutcome | "">("");
  const [outcomeNotes, setOutcomeNotes] = useState("");
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [outcomeSaved, setOutcomeSaved] = useState(false);
  const [excludeSaving, setExcludeSaving] = useState(false);

  // Portal-reply composer state (open by default — the hot-lead email's
  // "Reply" button lands the client here to respond).
  const [composerSubject, setComposerSubject] = useState("");
  const [composerBody, setComposerBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    if (contextLoading || !client || !id) return;
    const supabase = createClient();
    supabase
      .from("lead_replies")
      .select("*")
      .eq("id", id)
      .eq("client_id", client.id)
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          setNotFound(true);
        } else {
          const r = data as LeadReply;
          setReply(r);
          if (r.outcome) setOutcomeValue(r.outcome);
          if (r.outcome_notes) setOutcomeNotes(r.outcome_notes);
          // Prefill the subject as "Re: <original>" so the client doesn't
          // have to type it. Send-path would do the same if subject is empty,
          // but seeing it up front is clearer.
          const re = r.subject?.startsWith("Re:")
            ? r.subject
            : r.subject
              ? `Re: ${r.subject}`
              : "";
          setComposerSubject(re);
        }
        setLoading(false);
      });
  }, [contextLoading, client, id]);

  async function handleSend() {
    if (!reply || !composerBody.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(appUrl(`/api/replies/${reply.id}/send`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: composerSubject.trim() || undefined,
          body_text: composerBody,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSendError(data.error || "Failed to send.");
      } else {
        setReply((prev) =>
          prev && {
            ...prev,
            status: "sent",
            sent_at: data.sent_at,
            sent_external_email_id: data.sent_external_email_id,
            final_body_text: composerBody,
          }
        );
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setSending(false);
    }
  }

  async function handleSaveOutcome() {
    if (!reply || !outcomeValue) return;
    setSavingOutcome(true);
    setOutcomeSaved(false);
    try {
      const res = await fetch(appUrl(`/api/replies/${reply.id}/outcome`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: outcomeValue,
          outcome_notes: outcomeNotes || null,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setOutcomeSaved(true);
        setReply((prev) =>
          prev && {
            ...prev,
            outcome: outcomeValue,
            outcome_notes: outcomeNotes || null,
            outcome_logged_at: data.outcome_logged_at,
            status: data.status ?? prev.status,
          }
        );
        setTimeout(() => setOutcomeSaved(false), 2000);
      } else {
        console.error("[outcome] save failed:", data);
      }
    } finally {
      setSavingOutcome(false);
    }
  }

  async function handleToggleExclude() {
    if (!reply) return;
    const next = !reply.excluded_from_stats;
    setExcludeSaving(true);
    try {
      const res = await fetch(appUrl(`/api/replies/${reply.id}/exclude`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: next }),
      });
      if (res.ok) {
        setReply((prev) => prev && { ...prev, excluded_from_stats: next });
      }
    } finally {
      setExcludeSaving(false);
    }
  }

  if (contextLoading || loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-6 w-32 rounded bg-muted/50" />
        <div className="h-40 rounded-xl bg-muted/50" />
        <div className="h-16 rounded-xl bg-muted/50" />
        <div className="h-32 rounded-xl bg-muted/50" />
      </div>
    );
  }

  if (notFound || !reply) {
    return (
      <div className="space-y-4">
        <Link
          href="/client/inbox"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft size={14} /> Back to inbox
        </Link>
        <Card className="border-border/50">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Reply not found or you don&apos;t have access.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const callLink = telHref(reply.lead_phone_e164);
  const urgency = urgencyColor(reply.received_at);

  // Identity: a known person, or a generic company inbox (no lead_name — e.g.
  // a Maps info@ lead) where the email itself is the identity.
  const isGeneric = !reply.lead_name?.trim();
  const emailDomain = reply.lead_email.includes("@") ? reply.lead_email.split("@")[1] : "";
  const displayName =
    reply.lead_name?.trim() || reply.lead_company?.trim() || emailDomain || reply.lead_email;
  const subParts = [reply.lead_title, reply.lead_company].filter(Boolean).join(" · ");
  const monogram = isGeneric ? "🏢" : initials(reply.lead_name || "");
  const avatarBg = isGeneric ? SLATE : GRAD;

  const isReplyable = reply.final_class ? REPLYABLE_CLASSES.includes(reply.final_class) : false;
  const isSent = reply.status === "sent";

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* Back */}
      <Link
        href="/client/inbox"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft size={14} /> Back to inbox
      </Link>

      {/* Urgency */}
      {isReplyActionable(reply) && (
        <div
          className="flex items-center gap-3 rounded-xl px-4 py-3"
          style={{ background: `${urgency}14`, border: `1px solid ${urgency}33` }}
        >
          <AlertCircle size={18} style={{ color: urgency }} />
          <div className="text-sm">
            <span className="font-semibold" style={{ color: urgency }}>
              Received {timeSince(reply.received_at)}.
            </span>{" "}
            <span className="text-foreground/80">The faster you respond, the more likely you win.</span>
          </div>
        </div>
      )}

      {/* Contact / company card */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4 space-y-4">
          <div className="flex items-start gap-3">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white font-bold text-lg leading-none"
              style={{ background: avatarBg }}
            >
              {monogram}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold text-foreground truncate">{displayName}</h2>
              {isGeneric ? (
                <>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70 mt-1.5">
                    Company email
                  </p>
                  <a
                    href={`mailto:${reply.lead_email}`}
                    className="text-sm font-semibold text-[#2E37FE] break-all"
                  >
                    {reply.lead_email}
                  </a>
                </>
              ) : (
                subParts && <p className="text-sm text-muted-foreground mt-0.5">{subParts}</p>
              )}
            </div>
          </div>

          {/* Detail rows */}
          {(!isGeneric || reply.lead_phone_e164 || reply.lead_linkedin_url) && (
            <div className="border-t border-border/40 text-sm">
              {!isGeneric && (
                <div className="flex items-center justify-between gap-3 py-2.5 border-b border-border/30">
                  <span className="text-muted-foreground">Email</span>
                  <a href={`mailto:${reply.lead_email}`} className="font-semibold text-[#2E37FE] truncate">
                    {reply.lead_email}
                  </a>
                </div>
              )}
              {reply.lead_phone_e164 && (
                <div className="flex items-center justify-between gap-3 py-2.5 border-b border-border/30">
                  <span className="text-muted-foreground">Phone</span>
                  <a href={callLink ?? "#"} className="font-semibold text-foreground">
                    {reply.lead_phone_e164}
                  </a>
                </div>
              )}
              {reply.lead_linkedin_url && (
                <div className="flex items-center justify-between gap-3 py-2.5 border-b border-border/30">
                  <span className="text-muted-foreground">LinkedIn</span>
                  <a
                    href={reply.lead_linkedin_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-semibold text-[#2E37FE]"
                  >
                    View profile <ExternalLink size={11} />
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Actions: Call (green) + LinkedIn (blue) */}
          {(callLink || reply.lead_linkedin_url) && (
            <div className="flex gap-2.5">
              {callLink && (
                <a
                  href={callLink}
                  className="flex-1 text-center text-white font-bold text-sm rounded-[10px] py-3 no-underline"
                  style={{ background: GREEN }}
                >
                  📞 Call
                </a>
              )}
              {reply.lead_linkedin_url && (
                <a
                  href={reply.lead_linkedin_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 text-center text-white font-bold text-sm rounded-[10px] py-3 no-underline"
                  style={{ background: BLUE }}
                >
                  💼 LinkedIn
                </a>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Their reply — chat bubble */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Their reply
          </p>
          <div className="flex gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white font-bold text-xs leading-none"
              style={{ background: avatarBg }}
            >
              {monogram}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-foreground">
                {displayName}
                {isGeneric ? (
                  <span className="text-xs font-normal text-muted-foreground"> · {reply.lead_email}</span>
                ) : (
                  <span className="text-xs font-normal text-muted-foreground"> replied</span>
                )}
              </p>
              <p className="text-[11px] text-muted-foreground mb-2">
                {formatReceived(reply.received_at)} · {timeSince(reply.received_at)}
                {reply.subject ? ` · ${reply.subject}` : ""}
              </p>
              <div
                className="rounded-[4px_14px_14px_14px] bg-[#F1F2F9] px-4 py-3 text-sm text-foreground leading-relaxed whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: formatBody(reply.body_text) }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Referral contact (if class === referral_forward) */}
      {reply.referral_contact && (
        <Card className="border-purple-200 bg-purple-50/50">
          <CardContent className="px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-purple-700 mb-1">
              Referred contact
            </p>
            <p className="text-sm font-medium text-foreground">
              {reply.referral_contact.name || reply.referral_contact.email}
            </p>
            {reply.referral_contact.title && (
              <p className="text-xs text-muted-foreground">{reply.referral_contact.title}</p>
            )}
            <p className="text-xs text-purple-700 mt-1">{reply.referral_contact.email}</p>
          </CardContent>
        </Card>
      )}

      {/* Reply composer (open) OR sent confirmation */}
      {isSent ? (
        <Card className="border-emerald-200 bg-emerald-50/40 shadow-sm">
          <CardContent className="px-5 py-4">
            <div className="flex items-start gap-2">
              <CheckCircle2 size={16} className="text-emerald-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-emerald-900">
                  Reply sent {reply.sent_at ? timeSince(reply.sent_at) : ""}
                </p>
                <p className="text-xs text-emerald-800 mt-0.5">
                  CC&apos;d to your inbox so the thread continues there.
                </p>
                {reply.final_body_text && (
                  <details className="mt-3">
                    <summary className="text-xs text-emerald-800/80 cursor-pointer hover:text-emerald-900">
                      View sent message
                    </summary>
                    <pre className="mt-2 text-xs text-foreground whitespace-pre-wrap font-sans bg-white/60 rounded-lg p-3 border border-emerald-200/60">
                      {reply.final_body_text}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : isReplyable ? (
        <Card className="shadow-sm" style={{ borderColor: "#C9CEEA" }}>
          <CardContent className="px-5 py-4 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#2E37FE]">
              ✍️ Your reply
            </p>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Subject
              </label>
              <input
                type="text"
                value={composerSubject}
                onChange={(e) => setComposerSubject(e.target.value)}
                disabled={sending}
                className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2E37FE]/30 disabled:opacity-60"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Message
              </label>
              <textarea
                value={composerBody}
                onChange={(e) => setComposerBody(e.target.value)}
                rows={9}
                placeholder="Write your reply…"
                disabled={sending}
                className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-[#2E37FE]/30 disabled:opacity-60"
              />
            </div>

            {sendError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
                {sendError}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <p className="text-[11px] text-muted-foreground">
                Sends from the mailbox they replied to and CC&apos;s your inbox, so the whole thread stays in one place.
              </p>
              <button
                onClick={handleSend}
                disabled={!composerBody.trim() || sending}
                className="text-white rounded-[10px] px-5 py-2.5 text-sm font-bold inline-flex items-center gap-1.5 shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: GRAD }}
              >
                <Send size={14} />
                {sending ? "Sending…" : "Send reply"}
              </button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Outcome capture */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {reply.outcome ? "Outcome" : "What happened?"}
            </p>
            {reply.outcome_logged_at && (
              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Clock size={10} /> logged {timeSince(reply.outcome_logged_at)}
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground -mt-1">
            Tell us what happened — it keeps your dashboard and reports accurate.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {OUTCOME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setOutcomeValue(opt.value)}
                className={`text-left text-sm px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                  outcomeValue === opt.value
                    ? "border-[#2E37FE] bg-[#2E37FE]/10 text-[#2E37FE] font-medium"
                    : "border-border/60 hover:bg-muted/50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <textarea
            placeholder="Notes (optional)"
            value={outcomeNotes}
            onChange={(e) => setOutcomeNotes(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#2E37FE]/30"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              {outcomeSaved && (
                <span className="flex items-center gap-1 text-emerald-600 font-medium">
                  <CheckCircle2 size={14} /> Saved
                </span>
              )}
            </div>
            <button
              onClick={handleSaveOutcome}
              disabled={!outcomeValue || savingOutcome}
              className="btn-blue px-5 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingOutcome ? "Saving..." : reply.outcome ? "Update" : "Log outcome"}
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Exclude from stats */}
      <Card className={reply.excluded_from_stats ? "border-amber-200 bg-amber-50/40" : "border-border/50 shadow-sm"}>
        <CardContent className="px-5 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {reply.excluded_from_stats ? "Excluded from your stats" : "Counted in your stats"}
            </p>
            <p className="text-xs text-muted-foreground">
              {reply.excluded_from_stats
                ? "This lead isn't counted in your dashboard or reports."
                : "Not a real lead? Exclude it so it doesn't count toward your metrics."}
            </p>
          </div>
          <button
            onClick={handleToggleExclude}
            disabled={excludeSaving}
            className="btn-secondary-white px-3 py-1.5 text-xs shrink-0 cursor-pointer disabled:opacity-50"
          >
            {excludeSaving ? "…" : reply.excluded_from_stats ? "Include" : "Exclude"}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
