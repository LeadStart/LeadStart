import type { CampaignSnapshot, KPIMetrics } from "@/types/app";

export function calculateMetrics(snapshots: CampaignSnapshot[]): KPIMetrics {
  const totals = snapshots.reduce(
    (acc, s) => ({
      emails_sent: acc.emails_sent + s.emails_sent,
      replies: acc.replies + s.replies,
      unique_replies: acc.unique_replies + s.unique_replies,
      positive_replies: acc.positive_replies + s.positive_replies,
      bounces: acc.bounces + s.bounces,
      unsubscribes: acc.unsubscribes + s.unsubscribes,
      meetings_booked: acc.meetings_booked + s.meetings_booked,
    }),
    {
      emails_sent: 0,
      replies: 0,
      unique_replies: 0,
      positive_replies: 0,
      bounces: 0,
      unsubscribes: 0,
      meetings_booked: 0,
    }
  );

  const sent = totals.emails_sent;
  const replies = totals.unique_replies;

  return {
    ...totals,
    reply_rate: sent > 0 ? Number(((replies / sent) * 100).toFixed(2)) : 0,
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
