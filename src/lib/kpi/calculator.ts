import type { CampaignSnapshot, KPIMetrics } from "@/types/app";

// Reply rate is per-contact everywhere: repliers ÷ contacts contacted, "of the
// people we first emailed, what share replied": rather than replies ÷ emails
// sent. This holds for any set of snapshots, windowed or lifetime:
//
//   - Numerator: cohort_replies (distinct repliers attributed to their
//     first-touch day; written by sync-analytics). Falls back to unique_replies
//     when cohort data isn't populated yet: the window between migration 00093
//     and the next cron tick, so the number degrades gracefully instead of
//     reading 0%.
//   - Denominator: new_leads_contacted (distinct contacts whose first email
//     went out). In a windowed view both sides cover the same cohort: contacts
//     first-emailed inside the window, so a 7-day rate stays honest instead of
//     dividing window replies by an all-history contact base.
//
// positive_reply_rate and reply_to_meeting_rate stay ratios OF replies, so they
// keep the arrival-based unique_replies denominator (their numerators are
// arrival-based too): only the headline reply_rate becomes per-contact.
export function calculateMetrics(snapshots: CampaignSnapshot[]): KPIMetrics {
  const totals = snapshots.reduce(
    (acc, s) => ({
      emails_sent: acc.emails_sent + s.emails_sent,
      replies: acc.replies + s.replies,
      unique_replies: acc.unique_replies + s.unique_replies,
      cohort_replies: acc.cohort_replies + (s.cohort_replies ?? 0),
      positive_replies: acc.positive_replies + s.positive_replies,
      bounces: acc.bounces + s.bounces,
      unsubscribes: acc.unsubscribes + s.unsubscribes,
      meetings_booked: acc.meetings_booked + s.meetings_booked,
      new_leads_contacted: acc.new_leads_contacted + (s.new_leads_contacted ?? 0),
    }),
    {
      emails_sent: 0,
      replies: 0,
      unique_replies: 0,
      cohort_replies: 0,
      positive_replies: 0,
      bounces: 0,
      unsubscribes: 0,
      meetings_booked: 0,
      new_leads_contacted: 0,
    }
  );

  const sent = totals.emails_sent;
  const leadsContacted = totals.new_leads_contacted;
  // Per-contact numerator: prefer the cohort-attributed count; fall back to the
  // per-day unique count until cohort_replies is populated.
  const cohortRepliers =
    totals.cohort_replies > 0 ? totals.cohort_replies : totals.unique_replies;
  // Arrival-based repliers, for the ratio-of-replies metrics below.
  const replies = totals.unique_replies;

  const replyRate =
    leadsContacted > 0
      ? Number(((cohortRepliers / leadsContacted) * 100).toFixed(2))
      : 0;

  return {
    emails_sent: totals.emails_sent,
    replies: totals.replies,
    unique_replies: totals.unique_replies,
    positive_replies: totals.positive_replies,
    bounces: totals.bounces,
    unsubscribes: totals.unsubscribes,
    meetings_booked: totals.meetings_booked,
    new_leads_contacted: totals.new_leads_contacted,
    reply_rate: replyRate,
    positive_reply_rate: replies > 0 ? Number(((totals.positive_replies / replies) * 100).toFixed(2)) : 0,
    bounce_rate: sent > 0 ? Number(((totals.bounces / sent) * 100).toFixed(2)) : 0,
    unsubscribe_rate: sent > 0 ? Number(((totals.unsubscribes / sent) * 100).toFixed(2)) : 0,
    reply_to_meeting_rate: replies > 0 ? Number(((totals.meetings_booked / replies) * 100).toFixed(2)) : 0,
  };
}

export function calculateDailyAvgSent(snapshots: CampaignSnapshot[]): number {
  if (snapshots.length === 0) return 0;
  const totalSent = snapshots.reduce((acc, s) => acc + s.emails_sent, 0);
  return Math.round(totalSent / snapshots.length);
}
