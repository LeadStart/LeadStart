import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { SEND_WINDOW } from "@/lib/gmail/ramp";
import { todayIn } from "@/lib/planner/dates";
import { Planner, type ReplyHistory } from "@/components/planner/planner";
import type { CampaignSnapshot } from "@/types/app";

export const metadata = { title: "Planner, LeadStart" };

type SnapshotRow = Pick<
  CampaignSnapshot,
  | "campaign_id"
  | "emails_sent"
  | "replies"
  | "unique_replies"
  | "cohort_replies"
  | "positive_replies"
  | "bounces"
  | "unsubscribes"
  | "meetings_booked"
  | "new_leads_contacted"
>;

// The org's all-time reply history (same per-contact reply rate the KPI cards
// use), for the planner's default reply rates. null when nothing has sent yet.
async function loadReplyHistory(): Promise<ReplyHistory | null> {
  const supabase = await createClient();
  const snapshots = await fetchAllRows<SnapshotRow>(() =>
    supabase
      .from("campaign_snapshots")
      .select(
        "campaign_id, emails_sent, replies, unique_replies, cohort_replies, positive_replies, bounces, unsubscribes, meetings_booked, new_leads_contacted",
      )
      .order("id", { ascending: true }),
  );
  // calculateMetrics only reads the columns selected above.
  const m = calculateMetrics(snapshots as CampaignSnapshot[]);
  if (m.new_leads_contacted <= 0) return null;
  const campaigns = new Set(snapshots.filter((s) => (s.new_leads_contacted ?? 0) > 0).map((s) => s.campaign_id)).size;
  return {
    replyRatePct: m.reply_rate,
    positiveRatePct: m.positive_reply_rate,
    contacted: m.new_leads_contacted,
    replies: m.unique_replies,
    positives: m.positive_replies,
    campaigns,
  };
}

export default async function PlannerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, history] = await Promise.all([searchParams, loadReplyHistory()]);
  // "Today" in the send window's timezone, computed once here so the server
  // render and the browser render agree on every date.
  const today = todayIn(SEND_WINDOW.timezone);
  return <Planner initialParams={params} today={today} history={history} />;
}
