// Shared UI constants + formatting helpers for the reply-routing inbox
// surfaces (client portal + admin oversight). Keep presentation here so the
// two surfaces can't drift.

import type { ReplyClass, ReplyOutcome, ReplyStatus } from "@/types/app";

export interface ReplyClassMeta {
  label: string;
  badge: string; // Tailwind class suffix: badge-green / badge-blue / badge-amber / ...
  urgent: boolean; // "waiting for client action" surface
}

export const CLASS_META: Record<ReplyClass, ReplyClassMeta> = {
  true_interest:            { label: "Interested",        badge: "badge-green",  urgent: true },
  meeting_booked:           { label: "Meeting Booked",    badge: "badge-green",  urgent: true },
  qualifying_question:      { label: "Has Question",      badge: "badge-blue",   urgent: true },
  referral_forward:         { label: "Referral",          badge: "badge-purple", urgent: true },
  objection_price:          { label: "Price Concern",     badge: "badge-amber",  urgent: false },
  objection_timing:         { label: "Timing Concern",    badge: "badge-amber",  urgent: false },
  wrong_person_no_referral: { label: "Wrong Person",      badge: "badge-slate",  urgent: false },
  ooo:                      { label: "Out of Office",     badge: "badge-slate",  urgent: false },
  not_interested:           { label: "Not Interested",    badge: "badge-red",    urgent: false },
  unsubscribe:              { label: "Unsubscribed",      badge: "badge-red",    urgent: false },
  needs_review:             { label: "Needs Review",      badge: "badge-amber",  urgent: false },
};

export interface OutcomeOption {
  value: ReplyOutcome;
  label: string;
  badge: string;
}

export const OUTCOME_OPTIONS: OutcomeOption[] = [
  { value: "called_booked",    label: "Called — booked",      badge: "badge-green" },
  { value: "called_vm",        label: "Called — left VM",     badge: "badge-amber" },
  { value: "called_no_answer", label: "Called — no answer",   badge: "badge-amber" },
  { value: "emailed",          label: "Emailed instead",      badge: "badge-blue" },
  { value: "no_contact",       label: "No contact",           badge: "badge-slate" },
];

export const OUTCOME_META: Record<ReplyOutcome, OutcomeOption> = OUTCOME_OPTIONS.reduce(
  (acc, opt) => { acc[opt.value] = opt; return acc; },
  {} as Record<ReplyOutcome, OutcomeOption>
);

// "4 min ago" / "2h 15m ago" / "3d ago"
export function timeSince(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${days}d ago`;
}

// Shortform for list views: "4m" / "2h" / "3d"
export function timeSinceShort(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  return `${days}d`;
}

// Format E.164-ish phone to a `tel:` URL, stripping all non-digits except
// the leading +.
export function telHref(phone: string | null): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, "");
  return cleaned ? `tel:${cleaned}` : null;
}

// Escape minimal HTML so we can safely insert plain-text body with <br>s
// via dangerouslySetInnerHTML. Does NOT handle rich content — webhook
// ingestion should give us body_text (plain) for classification.
export function formatBody(text: string | null): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

/**
 * "Needs action" / urgency check. True when the reply is in a hot class,
 * hasn't been outcome-logged, AND hasn't been resolved by sending a portal
 * reply or aging out. Centralized here so the client inbox, dossier, and
 * admin oversight all agree on what counts as outstanding work.
 */
export function isReplyActionable(reply: {
  final_class: ReplyClass | null;
  outcome: ReplyOutcome | null;
  status: ReplyStatus;
}): boolean {
  if (!reply.final_class) return false;
  if (!CLASS_META[reply.final_class]?.urgent) return false;
  if (reply.outcome) return false;
  return reply.status === "new" || reply.status === "classified";
}

// Urgency color ramp for the dossier banner — green < 15min, amber < 1h, red after.
export function urgencyColor(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 15) return "#10b981";
  if (mins < 60) return "#f59e0b";
  return "#ef4444";
}
