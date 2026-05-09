import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ChevronLeft,
  Building2,
  ExternalLink,
  MailOpen,
  Phone,
  Clock,
  Bot,
  Eye,
} from "lucide-react";
import type { LeadReply } from "@/types/app";
import { CLASS_META, OUTCOME_META, timeSince, formatBody } from "@/lib/replies/ui";
import { ReclassifyForm } from "./reclassify-form";

// Detail-page columns. Skips the heavy stuff a single-row read doesn't
// need: raw_payload + body_html (we render body_text), final_body_*
// (portal-send state, not shown here), notification/enrichment retry
// metadata, and per-channel id plumbing.
const REPLY_DETAIL_COLUMNS =
  "id, client_id, final_class, status, received_at, " +
  "lead_email, lead_name, lead_company, lead_title, lead_phone_e164, lead_linkedin_url, " +
  "subject, body_text, " +
  "instantly_category, claude_class, claude_confidence, claude_reason, " +
  "keyword_flags, referral_contact, " +
  "outcome, outcome_notes, outcome_logged_at, " +
  "reclassified_from, reclassified_at, " +
  "client:client_id(name, notification_email)";

type DetailReply = Pick<
  LeadReply,
  | "id"
  | "client_id"
  | "final_class"
  | "status"
  | "received_at"
  | "lead_email"
  | "lead_name"
  | "lead_company"
  | "lead_title"
  | "lead_phone_e164"
  | "lead_linkedin_url"
  | "subject"
  | "body_text"
  | "instantly_category"
  | "claude_class"
  | "claude_confidence"
  | "claude_reason"
  | "keyword_flags"
  | "referral_contact"
  | "outcome"
  | "outcome_notes"
  | "outcome_logged_at"
  | "reclassified_from"
  | "reclassified_at"
> & {
  client: { name: string; notification_email: string | null } | null;
};

export default async function AdminReplyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("lead_replies")
    .select(REPLY_DETAIL_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error || !data) {
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

  const reply = data as unknown as DetailReply;
  const meta = reply.final_class ? CLASS_META[reply.final_class] : null;
  const outcomeMeta = reply.outcome ? OUTCOME_META[reply.outcome] : null;

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <Link
        href="/admin/inbox"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <ChevronLeft size={14} /> Back
      </Link>

      <div className="flex items-center gap-2 rounded-xl px-4 py-2 bg-slate-100 text-slate-700 text-xs">
        <Eye size={14} />
        <span>
          Admin view — the client sees this reply in their own inbox with phone
          CTA + outcome capture.
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
                  <Badge
                    variant="secondary"
                    className={`${meta.badge} text-[10px] shrink-0`}
                  >
                    {meta.label}
                  </Badge>
                )}
              </div>
              {reply.lead_company && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-1">
                  <Building2 size={14} />
                  <span>{reply.lead_company}</span>
                  {reply.lead_title && (
                    <span className="text-muted-foreground/70">
                      {" "}
                      · {reply.lead_title}
                    </span>
                  )}
                </div>
              )}
              <div className="flex items-center gap-3 mt-2 text-xs">
                <span className="text-muted-foreground">
                  Client:{" "}
                  <span className="text-foreground font-medium">
                    {reply.client?.name}
                  </span>
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
            <p className="text-sm font-semibold text-foreground mb-2">
              {reply.subject}
            </p>
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
                {reply.instantly_category || (
                  <span className="text-muted-foreground">—</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Claude class</p>
              <p className="font-medium text-foreground">
                {reply.claude_class || (
                  <span className="text-muted-foreground">—</span>
                )}
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
              <p className="text-xs text-muted-foreground italic">
                &ldquo;{reply.claude_reason}&rdquo;
              </p>
            </div>
          )}

          {reply.referral_contact && (
            <div className="pt-2 border-t border-border/50">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Extracted referral
              </p>
              <p className="text-sm font-medium text-foreground">
                {reply.referral_contact.name || reply.referral_contact.email}
                {reply.referral_contact.title && (
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    — {reply.referral_contact.title}
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {reply.referral_contact.email}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardContent className="px-5 py-4">
          <ReclassifyForm
            replyId={reply.id}
            currentClass={reply.final_class}
          />
        </CardContent>
      </Card>

      {/* Outcome (read-only) */}
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
              <Badge
                variant="secondary"
                className={`${outcomeMeta.badge} text-[10px]`}
              >
                {outcomeMeta.label}
              </Badge>
              {reply.outcome_notes && (
                <p className="text-sm text-foreground whitespace-pre-wrap">
                  {reply.outcome_notes}
                </p>
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
