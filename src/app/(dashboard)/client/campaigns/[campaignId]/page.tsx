import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { KPICard } from "@/components/charts/kpi-card";
import { DailyChart } from "@/components/charts/daily-chart";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FeedbackForm } from "./feedback-form";
import { ArrowLeft, MessageSquare } from "lucide-react";
import type { Campaign, CampaignSnapshot, LeadFeedback } from "@/types/app";

export default async function ClientCampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const supabase = await createClient();

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();

  if (!campaign) notFound();

  const typedCampaign = campaign as Campaign;

  const [snapshotsRes, feedbackRes] = await Promise.all([
    supabase
      .from("campaign_snapshots")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("snapshot_date", { ascending: false }),
    supabase
      .from("lead_feedback")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false }),
  ]);

  const snapshots = (snapshotsRes.data || []) as CampaignSnapshot[];
  const feedback = (feedbackRes.data || []) as LeadFeedback[];
  const metrics = calculateMetrics(snapshots);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link href="/client" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft size={14} />
          Back to Dashboard
        </Link>
        <div className="relative overflow-hidden rounded-xl p-6 text-white mt-3" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
          <div className="relative z-10">
            <Badge className="bg-white/15 text-white border-0 mb-2">
              {typedCampaign.status}
            </Badge>
            <h1 className="text-2xl font-bold">{typedCampaign.name}</h1>
          </div>
          <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard label="Emails Sent" value={metrics.emails_sent} unit="count" />
        <KPICard label="Reply Rate" value={metrics.reply_rate} unit="percent" kpiKey="reply_rate" />
        <KPICard label="Bounce Rate" value={metrics.bounce_rate} unit="percent" kpiKey="bounce_rate" />
        <KPICard label="Meetings Booked" value={metrics.meetings_booked} unit="count" />
      </div>

      {/* Chart */}
      {snapshots.length > 0 && <DailyChart snapshots={snapshots} />}

      {/* Submit Feedback */}
      <FeedbackForm campaignId={campaignId} />

      {/* Existing Feedback */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <MessageSquare size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Your Feedback ({feedback.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {feedback.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No feedback submitted yet. Use the form above to rate lead quality.
            </p>
          ) : (
            <div className="space-y-2">
              {feedback.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-3 rounded-xl border border-border/50 p-3 text-sm transition-colors hover:bg-muted/30"
                >
                  <Badge
                    variant="secondary"
                    className={
                      ["good_lead", "interested"].includes(f.status)
                        ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                        : ["bad_lead", "wrong_person", "not_interested"].includes(f.status)
                        ? "bg-red-100 text-red-800 border border-red-200"
                        : "bg-gray-100 text-gray-600 border border-gray-200"
                    }
                  >
                    {f.status.replace(/_/g, " ")}
                  </Badge>
                  <span className="font-medium">{f.lead_email}</span>
                  {f.comment && (
                    <span className="text-muted-foreground truncate">{f.comment}</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(f.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
