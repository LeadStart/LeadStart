"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { appUrl } from "@/lib/api-url";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  Building2,
  ExternalLink,
  MailOpen,
  Phone,
  Clock,
  UserCheck,
  Bot,
  Eye,
  CheckCircle2,
} from "lucide-react";
import type { LeadReply, ReplyClass } from "@/types/app";
import { CLASS_META, OUTCOME_META, timeSince, formatBody } from "@/lib/replies/ui";

const RECLASSIFY_OPTIONS: { value: ReplyClass; label: string }[] = [
  { value: "true_interest",            label: "Interested" },
  { value: "meeting_booked",           label: "Meeting Booked" },
  { value: "qualifying_question",      label: "Has Question" },
  { value: "referral_forward",         label: "Referral" },
  { value: "objection_price",          label: "Price Concern" },
  { value: "objection_timing",         label: "Timing Concern" },
  { value: "wrong_person_no_referral", label: "Wrong Person" },
  { value: "ooo",                      label: "Out of Office" },
  { value: "not_interested",           label: "Not Interested" },
  { value: "unsubscribe",              label: "Unsubscribed" },
];

interface AdminReply extends LeadReply {
  client?: { name: string; notification_email: string | null } | null;
}

export default function AdminReplyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [reply, setReply] = useState<AdminReply | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Reclassify state
  const [newClass, setNewClass] = useState<ReplyClass | "">("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!id) return;
    const supabase = createClient();
    supabase
      .from("lead_replies")
      .select("*, client:client_id(name, notification_email)")
      .eq("id", id)
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          setNotFound(true);
        } else {
          setReply(data as AdminReply);
        }
        setLoading(false);
      });
  }, [id]);

  async function handleReclassify() {
    if (!reply || !newClass || newClass === reply.final_class) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(appUrl(`/api/replies/${reply.id}/reclassify`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ final_class: newClass }),
      });
      const data = await res.json();
      if (res.ok) {
        setSaved(true);
        setReply((prev) =>
          prev && {
            ...prev,
            final_class: newClass,
            status: data.status ?? prev.status,
            reclassified_from: data.reclassified_from ?? prev.reclassified_from,
            reclassified_at: data.reclassified_at ?? prev.reclassified_at,
          }
        );
        setNewClass("");
        setTimeout(() => setSaved(false), 2000);
      } else {
        console.error("[reclassify] save failed:", data);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-6 w-32 rounded bg-muted/50" />
        <div className="h-24 rounded-xl bg-muted/50" />
        <div className="h-32 rounded-xl bg-muted/50" />
        <div className="h-40 rounded-xl bg-muted/50" />
      </div>
    );
  }

  if (notFound || !reply) {
    return (
      <div className="space-y-4">
        <Link
          href="/admin/inbox"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft size={14} /> Back to Inbox
        </Link>
        <Card className="border-border/50">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Reply not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const meta = reply.final_class ? CLASS_META[reply.final_class] : null;
  const outcomeMeta = reply.outcome ? OUTCOME_META[reply.outcome] : null;

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      {/* Back */}
      <button
        onClick={() => router.back()}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <ChevronLeft size={14} /> Back
      </button>

      {/* Observer banner */}
      <div className="flex items-center gap-2 rounded-xl px-4 py-2 bg-slate-100 text-slate-700 text-xs">
        <Eye size={14} />
        <span>
          Admin view — the client sees this reply in their own inbox with phone CTA + outcome capture.
        </span>
      </div>

      {/* Prospect + client card */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
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
                  {reply.lead_title && (
                    <span className="text-muted-foreground/70"> · {reply.lead_title}</span>
                  )}
                </div>
              )}
              <div className="flex items-center gap-3 mt-2 text-xs">
                <span className="text-muted-foreground">
                  Client: <span className="text-foreground font-medium">{reply.client?.name}</span>
                </span>
                {reply.lead_phone_e164 && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Phone size={11} /> {reply.lead_phone_e164}
                  </span>
                )}
              </div>
            </div>
            {reply.lead_linkedin_url && (
              <a
                href={reply.lead_linkedin_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#0077b5] hover:bg-[#0077b5]/10 shrink-0"
              >
                LinkedIn <ExternalLink size={12} />
              </a>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Reply body */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MailOpen size={14} className="text-muted-foreground" />
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Their reply
              </p>
            </div>
            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Clock size={10} /> {timeSince(reply.received_at)}
            </p>
          </div>
          {reply.subject && (
            <p className="text-sm font-semibold text-foreground mb-2">{reply.subject}</p>
          )}
          <div
            className="text-sm text-foreground leading-relaxed whitespace-pre-wrap"
            dangerouslySetInnerHTML={{ __html: formatBody(reply.body_text) }}
          />
        </CardContent>
      </Card>

      {/* Classification audit */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2">
            <Bot size={14} className="text-[#2E37FE]" />
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Classification trail
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div>
              <p className="text-muted-foreground">Instantly tag</p>
              <p className="font-medium text-foreground">
                {reply.instantly_category || <span className="text-muted-foreground">—</span>}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Claude class</p>
              <p className="font-medium text-foreground">
                {reply.claude_class || <span className="text-muted-foreground">—</span>}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Confidence</p>
              <p className="font-medium text-foreground">
                {reply.claude_confidence != null
                  ? `${Math.round(reply.claude_confidence * 100)}%`
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Keyword flags</p>
              <p className="font-medium text-foreground">
                {reply.keyword_flags && reply.keyword_flags.length > 0
                  ? reply.keyword_flags.join(", ")
                  : "—"}
              </p>
            </div>
          </div>
          {reply.claude_reason && (
            <div className="pt-2 border-t border-border/50">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Reason
              </p>
              <p className="text-xs text-muted-foreground italic">&ldquo;{reply.claude_reason}&rdquo;</p>
            </div>
          )}

          {/* Referral detail */}
          {reply.referral_contact && (
            <div className="pt-2 border-t border-border/50">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Extracted referral
              </p>
              <p className="text-sm font-medium text-foreground">
                {reply.referral_contact.name || reply.referral_contact.email}
                {reply.referral_contact.title && (
                  <span className="text-muted-foreground font-normal"> — {reply.referral_contact.title}</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">{reply.referral_contact.email}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reclassify */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2">
            <UserCheck size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Reclassify
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Override the classifier. Useful for <code>needs_review</code> items or training-data
            correction. Does not re-notify the client.
          </p>
          <div className="flex items-center gap-2">
            <Select value={newClass} onValueChange={(v) => setNewClass((v as ReplyClass) || "")}>
              <SelectTrigger className="h-9 flex-1 text-sm">
                <SelectValue placeholder="Choose new class" />
              </SelectTrigger>
              <SelectContent>
                {RECLASSIFY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              onClick={handleReclassify}
              disabled={!newClass || newClass === reply.final_class || saving}
              className="btn-blue px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Apply"}
            </button>
          </div>
          {saved && (
            <p className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
              <CheckCircle2 size={12} /> Reclassified
            </p>
          )}
        </CardContent>
      </Card>

      {/* Outcome (read-only, reflects what the client logged) */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Client outcome
            </p>
            {reply.outcome_logged_at && (
              <p className="text-[10px] text-muted-foreground">
                logged {timeSince(reply.outcome_logged_at)}
              </p>
            )}
          </div>
          {outcomeMeta ? (
            <div className="space-y-2">
              <Badge variant="secondary" className={`${outcomeMeta.badge} text-[10px]`}>
                {outcomeMeta.label}
              </Badge>
              {reply.outcome_notes && (
                <p className="text-sm text-foreground whitespace-pre-wrap">{reply.outcome_notes}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              Client hasn&apos;t logged an outcome yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
