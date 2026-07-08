import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { KPICard } from "@/components/charts/kpi-card";
import { DailyChart } from "@/components/charts/daily-chart";
import { StepFunnel } from "@/components/charts/step-funnel";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { analyzeStepHealth } from "@/lib/kpi/step-health";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshButton } from "./refresh-button";
import { LinkedinCampaignDetail } from "./linkedin-campaign-detail";
import { ArrowLeft, MessageSquare } from "lucide-react";
import type {
  Campaign,
  CampaignSnapshot,
  CampaignStepMetric,
  LeadFeedback,
} from "@/types/app";

// Snapshot columns minus raw_data (the JSONB blob is write-only).
const SNAPSHOT_COLUMNS =
  "id, campaign_id, snapshot_date, total_leads, emails_sent, replies, " +
  "unique_replies, positive_replies, bounces, unsubscribes, meetings_booked, " +
  "new_leads_contacted, reply_rate, positive_reply_rate, bounce_rate, " +
  "unsubscribe_rate, fetched_at";

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ clientId: string; id: string }>;
}) {
  const { clientId, id: campaignId } = await params;
  const supabase = await createClient();

  const { data: campaignRow } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (!campaignRow) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Campaign not found.</p>
      </div>
    );
  }

  const campaign = campaignRow as Campaign;

  // LinkedIn campaigns get a different detail view — campaign_snapshots /
  // step_metrics are email-shaped and empty for LinkedIn.
  if (campaign.source_channel === "linkedin") {
    return (
      <LinkedinCampaignDetail clientId={clientId} campaignId={campaignId} />
    );
  }

  const [clientRes, snapshotsRes, feedbackRes, stepMetricsRes] =
    await Promise.all([
      campaign.client_id
        ? supabase
            .from("clients")
            .select("name")
            .eq("id", campaign.client_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("campaign_snapshots")
        .select(SNAPSHOT_COLUMNS)
        .eq("campaign_id", campaignId)
        .order("snapshot_date", { ascending: false }),
      supabase
        .from("lead_feedback")
        .select("*")
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: false }),
      supabase
        .from("campaign_step_metrics")
        .select("*")
        .eq("campaign_id", campaignId)
        .order("period_start", { ascending: true }),
    ]);

  const clientName =
    (clientRes.data as { name: string } | null)?.name || "Unknown";
  const snapshots = (snapshotsRes.data ?? []) as unknown as CampaignSnapshot[];
  const feedback = (feedbackRes.data ?? []) as LeadFeedback[];
  const stepMetrics = (stepMetricsRes.data ?? []) as CampaignStepMetric[];

  const metrics = calculateMetrics(snapshots, "lifetime");
  const campaignInfoMap = new Map([
    [
      campaignId,
      { id: campaignId, name: campaign.name, client_name: clientName },
    ],
  ]);
  const stepAlerts = analyzeStepHealth(stepMetrics, campaignInfoMap);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/admin/clients/${clientId}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back to Client
        </Link>
        <div
          className="relative overflow-hidden rounded-[12px] p-5 sm:p-7 text-[#0f172a] mt-3"
          style={{
            background:
              "#EDEEFF",
            border: "1px solid #e2e8f0",
            borderTop: "1px solid #e2e8f0",
            boxShadow:
              "none",
          }}
        >
          <div className="relative z-10 flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">{campaign.name}</h1>
              {campaign.salesforge_sequence_id && (
                <p className="text-xs text-[#0f172a]/50 font-mono mt-1">
                  {campaign.salesforge_sequence_id}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Badge
                className={
                  campaign.status === "active"
                    ? "bg-white/15 text-[#0f172a] border-0"
                    : "bg-white/10 text-[#0f172a]/60 border-0"
                }
              >
                {campaign.status}
              </Badge>
              <RefreshButton campaignId={campaignId} />
            </div>
          </div>
          <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-transparent" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard label="Emails Sent" value={metrics.emails_sent} unit="count" />
        <KPICard
          label="Reply Rate"
          value={metrics.reply_rate}
          unit="percent"
          kpiKey="reply_rate"
        />
        <KPICard
          label="Bounce Rate"
          value={metrics.bounce_rate}
          unit="percent"
          kpiKey="bounce_rate"
        />
        <KPICard
          label="Positive Responses"
          value={metrics.meetings_booked}
          unit="count"
        />
      </div>

      <DailyChart snapshots={snapshots} />

      <StepFunnel
        stepMetrics={stepMetrics}
        alerts={stepAlerts}
        campaignName={campaign.name}
      />

      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[15px] font-semibold text-[#0f172a]">
          Daily Breakdown
        </h2>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          {snapshots.length === 0 ? (
            <p className="text-sm text-muted-foreground">No data synced yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Replies</TableHead>
                  <TableHead className="text-right">Bounces</TableHead>
                  <TableHead className="text-right">Unsubs</TableHead>
                  <TableHead className="text-right">Positive</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.slice(0, 14).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-sm">
                      {s.snapshot_date}
                    </TableCell>
                    <TableCell className="text-right">
                      {s.emails_sent}
                    </TableCell>
                    <TableCell className="text-right">{s.replies}</TableCell>
                    <TableCell className="text-right">{s.bounces}</TableCell>
                    <TableCell className="text-right">
                      {s.unsubscribes}
                    </TableCell>
                    <TableCell className="text-right">
                      {s.meetings_booked}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <MessageSquare size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">
            Lead Feedback ({feedback.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {feedback.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No feedback submitted yet.
            </p>
          ) : (
            <div className="space-y-2">
              {feedback.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-3 rounded-xl border border-border/50 p-3 text-sm hover:bg-muted/30 transition-colors"
                >
                  <Badge
                    variant="secondary"
                    className={
                      ["good_lead", "interested"].includes(f.status)
                        ? "badge-green"
                        : ["bad_lead", "wrong_person", "not_interested"].includes(
                              f.status,
                            )
                          ? "badge-red"
                          : "badge-slate"
                    }
                  >
                    {f.status.replace(/_/g, " ")}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{f.lead_email}</p>
                    {f.lead_company && (
                      <p className="text-xs text-muted-foreground">
                        {f.lead_company}
                      </p>
                    )}
                  </div>
                  {f.comment && (
                    <span className="text-muted-foreground truncate hidden sm:inline text-xs max-w-xs">
                      {f.comment}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
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
