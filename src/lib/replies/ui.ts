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

// ===== Category segmentation =====
// The inbox groups replies into a handful of action buckets so the owner/VA
// can skim "what needs a call" vs "what's just noise" at a glance. Every
// ReplyClass belongs to exactly one category; order is priority (hottest
// first). Keep this the single source of truth for both inbox surfaces.

export type ReplyCategoryKey = "hot" | "objection" | "review" | "silent";

export interface ReplyCategoryMeta {
  key: ReplyCategoryKey;
  label: string;
  blurb: string;
  classes: ReplyClass[];
}

export const REPLY_CATEGORIES: ReplyCategoryMeta[] = [
  {
    key: "hot",
    label: "Hot — call now",
    blurb: "Interested, booked, asking, or referring",
    classes: ["true_interest", "meeting_booked", "qualifying_question", "referral_forward"],
  },
  {
    key: "objection",
    label: "Objections",
    blurb: "Price or timing pushback — worth a reply",
    classes: ["objection_price", "objection_timing"],
  },
  {
    key: "review",
    label: "Needs review",
    blurb: "Classifier wasn't sure — take a look",
    classes: ["needs_review"],
  },
  {
    key: "silent",
    label: "No action needed",
    blurb: "Out of office, wrong person, not interested, opt-out",
    classes: ["wrong_person_no_referral", "ooo", "not_interested", "unsubscribe"],
  },
];

// class → category. Unclassified rows (final_class null, e.g. status 'new'
// before the classifier ran) surface under "Needs review" so they're not lost.
const CATEGORY_BY_CLASS: Record<ReplyClass, ReplyCategoryKey> = REPLY_CATEGORIES.reduce(
  (acc, cat) => {
    for (const cls of cat.classes) acc[cls] = cat.key;
    return acc;
  },
  {} as Record<ReplyClass, ReplyCategoryKey>,
);

export function categoryForClass(cls: ReplyClass | null): ReplyCategoryKey {
  if (!cls) return "review";
  return CATEGORY_BY_CLASS[cls] ?? "review";
}

export interface OutcomeOption {
  value: ReplyOutcome;
  label: string;
  badge: string;
}

export const OUTCOME_OPTIONS: OutcomeOption[] = [
  { value: "called",     label: "Called",          badge: "badge-green" },
  { value: "emailed",    label: "Emailed instead", badge: "badge-blue"  },
  { value: "no_contact", label: "No contact",      badge: "badge-slate" },
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

// One-line preview of a reply for list views. Strips the quoted original
// (">" lines and the "On <date> … wrote:" / "Original Message" / Outlook
// divider tails) so we show what the person actually wrote, then collapses
// whitespace and truncates. Falls back to the subject when the body is empty
// (HTML-only replies can land with no plain-text body).
export function replySnippet(
  bodyText: string | null,
  subject: string | null = null,
  max = 140,
): string {
  let t = bodyText ?? "";
  // Cut everything from the first quoted-original marker onward.
  const markers = [
    /\nOn .+ wrote:/i,
    /\n-+\s*Original Message\s*-+/i,
    /\n_{5,}/, // Outlook reply divider
  ];
  for (const re of markers) {
    const idx = t.search(re);
    if (idx > 0) t = t.slice(0, idx);
  }
  // Drop any remaining quoted lines.
  t = t
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) t = (subject ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, "") + "…";
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
