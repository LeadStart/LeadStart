"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useClientData } from "../../client-data-context";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Phone,
  ChevronLeft,
  Building2,
  ExternalLink,
  MailOpen,
  AlertCircle,
  Clock,
  CheckCircle2,
  Send,
  Mail,
} from "lucide-react";
import type { LeadReply, ReplyClass, ReplyOutcome } from "@/types/app";
import {
  CLASS_META,
  OUTCOME_OPTIONS,
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

// ===== Page =====

export default function ReplyDossierPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { client, loading: contextLoading } = useClientData();

  const [reply, setReply] = useState<LeadReply | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Outcome UI state
  const [outcomeValue, setOutcomeValue] = useState<ReplyOutcome | "">("");
  const [outcomeNotes, setOutcomeNotes] = useState("");
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [outcomeSaved, setOutcomeSaved] = useState(false);

  // Portal-reply composer state
  const [composerOpen, setComposerOpen] = useState(false);
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
      const res = await fetch(`/api/replies/${reply.id}/send`, {
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
            sent_instantly_email_id: data.sent_instantly_email_id,
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
    // Stub: writes directly via RLS-permitted UPDATE. Commit #9 swaps this
    // for a POST to /api/replies/[id]/outcome which does audit logging.
    const supabase = createClient();
    const { error } = await supabase
      .from("lead_replies")
      .update({
        outcome: outcomeValue,
        outcome_notes: outcomeNotes || null,
        outcome_logged_at: new Date().toISOString(),
        status: outcomeValue === "emailed" ? reply.status : "resolved",
      })
      .eq("id", reply.id);
    setSavingOutcome(false);
    if (!error) {
      setOutcomeSaved(true);
      setReply((prev) => prev && {
        ...prev,
        outcome: outcomeValue,
        outcome_notes: outcomeNotes || null,
        outcome_logged_at: new Date().toISOString(),
      });
      setTimeout(() => setOutcomeSaved(false), 2000);
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
          <ChevronLeft size={14} /> Back to Inbox
        </Link>
        <Card className="border-border/50">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Reply not found or you don&apos;t have access.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const meta = reply.final_class ? CLASS_META[reply.final_class] : null;
  const callLink = telHref(reply.lead_phone_e164);
  const urgency = urgencyColor(reply.received_at);

  return (
    <div className="space-y-5 max-w-2xl mx-auto">
      {/* Back */}
      <button
        onClick={() => router.back()}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <ChevronLeft size={14} /> Back
      </button>

      {/* Urgency banner */}
      {meta?.urgent && !reply.outcome && (
        <div
          className="flex items-center gap-3 rounded-xl px-4 py-3"
          style={{
            background: `${urgency}15`,
            border: `1px solid ${urgency}40`,
          }}
        >
          <AlertCircle size={18} style={{ color: urgency }} />
          <div className="text-sm">
            <span className="font-semibold" style={{ color: urgency }}>
              Received {timeSince(reply.received_at)}.
            </span>{" "}
            <span className="text-foreground/80">Every minute matters — call now.</span>
          </div>
        </div>
      )}

      {/* Prospect card */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-bold text-foreground truncate">
                  {reply.lead_name || reply.lead_email}
                </h2>
                {meta && (
                  <Badge variant="secondary" className={`${meta.badge} text-[10px] shrink-0`}>
                    {meta.label}
                  </Badge>
                )}
              </div>
              {reply.lead_company && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-1">
                  <Building2 size={14} />
                  <span>{reply.lead_company}</span>
                  {reply.lead_title && <span className="text-muted-foreground/70"> · {reply.lead_title}</span>}
                </div>
              )}
            </div>
            {reply.lead_linkedin_url && (
              <a
                href={reply.lead_linkedin_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#0077b5] hover:bg-[#0077b5]/10 shrink-0"
                title="View LinkedIn"
              >
                LinkedIn <ExternalLink size={12} />
              </a>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Primary CTA: Call */}
      {callLink ? (
        <a
          href={callLink}
          className="btn-blue flex items-center justify-center gap-3 w-full py-5 text-base font-bold no-underline"
          style={{ fontSize: 18 }}
        >
          <Phone size={22} />
          <span>Call {reply.lead_phone_e164}</span>
        </a>
      ) : (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="py-4 text-center">
            <p className="text-sm text-amber-800">
              No phone number on this lead. Use the email-reply option below.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Reply body */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <MailOpen size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Their reply
            </p>
          </div>
          {reply.subject && (
            <p className="text-sm font-semibold text-foreground mb-2">{reply.subject}</p>
          )}
          <div
            className="text-sm text-foreground leading-relaxed whitespace-pre-wrap"
            dangerouslySetInnerHTML={{ __html: formatBody(reply.body_text) }}
          />
          {reply.claude_reason && (
            <div className="mt-3 pt-3 border-t border-border/50">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Why we flagged this
              </p>
              <p className="text-xs text-muted-foreground italic">&ldquo;{reply.claude_reason}&rdquo;</p>
            </div>
          )}
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

      {/* Reply via portal — manual composer (no AI drafting) */}
      {(() => {
        const isReplyable = reply.final_class
          ? REPLYABLE_CLASSES.includes(reply.final_class)
          : false;
        const isSent = reply.status === "sent";

        if (isSent) {
          return (
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
                          View sent body
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
          );
        }

        if (!isReplyable) return null;

        if (!composerOpen) {
          return (
            <Card className="border-border/50 shadow-sm">
              <CardContent className="px-5 py-4 text-center">
                <p className="text-xs text-muted-foreground mb-2">Prefer to respond by email?</p>
                <button
                  onClick={() => setComposerOpen(true)}
                  className="btn-secondary-white px-4 py-2 text-sm inline-flex items-center gap-2 cursor-pointer"
                >
                  <Mail size={14} /> Reply via portal
                </button>
              </CardContent>
            </Card>
          );
        }

        return (
          <Card className="border-border/50 shadow-sm">
            <CardContent className="px-5 py-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Reply via portal
                </p>
                <button
                  onClick={() => setComposerOpen(false)}
                  className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  Collapse
                </button>
              </div>

              <div className="space-y-2">
                <div>
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
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Body
                  </label>
                  <textarea
                    value={composerBody}
                    onChange={(e) => setComposerBody(e.target.value)}
                    rows={10}
                    placeholder="Write your reply…"
                    disabled={sending}
                    className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-[#2E37FE]/30 disabled:opacity-60 font-mono"
                  />
                </div>

                {sendError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
                    {sendError}
                  </div>
                )}

                <div className="flex items-center justify-end pt-1">
                  <button
                    onClick={handleSend}
                    disabled={!composerBody.trim() || sending}
                    className="btn-blue px-5 py-2 text-sm inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Send size={14} />
                    {sending ? "Sending…" : "Send reply"}
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground pt-1">
                  Sends from the same mailbox the prospect replied to, CC&apos;d to your inbox.
                </p>
              </div>
            </CardContent>
          </Card>
        );
      })()}
    </div>
  );
}
