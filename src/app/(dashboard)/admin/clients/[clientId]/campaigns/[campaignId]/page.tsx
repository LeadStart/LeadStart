"use client";

import { use } from "react";
import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { KPICard } from "@/components/charts/kpi-card";
import { DailyChart } from "@/components/charts/daily-chart";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { Campaign, CampaignSnapshot, LeadFeedback } from "@/types/app";

const supabase = createClient();

async function fetchCampaignDetail(campaignId: string) {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();

  if (!campaign) return null;

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

  return {
    campaign: campaign as Campaign,
    snapshots: (snapshotsRes.data || []) as CampaignSnapshot[],
    feedback: (feedbackRes.data || []) as LeadFeedback[],
  };
}

export default function CampaignDetailPage({
  params,
}: {
  params: Promise<{ clientId: string; campaignId: string }>;
}) {
  const { clientId, campaignId } = use(params);
  const { data } = useSWR(`admin-campaign-${campaignId}`, () => fetchCampaignDetail(campaignId));

  if (!data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 rounded bg-muted" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-muted" />
          ))}
        </div>
        <div className="h-64 rounded-xl bg-muted" />
      </div>
    );
  }

  if (!data.campaign) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Campaign not found.</p>
      </div>
    );
  }

  const { campaign: typedCampaign, snapshots, feedback } = data;
  const metrics = calculateMetrics(snapshots);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href={`/admin/clients/${clientId}`}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            &larr; Back to Client
          </Link>
          <h1 className="text-2xl font-bold mt-1">{typedCampaign.name}</h1>
          <p className="text-xs text-gray-500">
            Instantly ID: {typedCampaign.instantly_campaign_id}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className={
              typedCampaign.status === "active"
                ? "bg-green-100 text-green-800"
                : "bg-gray-100 text-gray-600"
            }
          >
            {typedCampaign.status}
          </Badge>
          <RefreshButton campaignId={campaignId} />
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard label="Emails Sent" value={metrics.emails_sent} unit="count" />
        <KPICard label="Reply Rate" value={metrics.reply_rate} unit="percent" kpiKey="reply_rate" />
        <KPICard
          label="Positive Reply Rate"
          value={metrics.positive_reply_rate}
          unit="percent"
          kpiKey="positive_reply_rate"
        />
        <KPICard label="Bounce Rate" value={metrics.bounce_rate} unit="percent" kpiKey="bounce_rate" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Unsubscribe Rate"
          value={metrics.unsubscribe_rate}
          unit="percent"
          kpiKey="unsubscribe_rate"
        />
        <KPICard label="Positive Responses" value={metrics.meetings_booked} unit="count" />
        <KPICard
          label="Reply-to-Meeting"
          value={metrics.reply_to_meeting_rate}
          unit="percent"
          kpiKey="reply_to_meeting_rate"
        />
        <KPICard label="Total Replies" value={metrics.unique_replies} unit="count" />
      </div>

      {/* Chart */}
      <DailyChart snapshots={snapshots} />

      {/* Snapshot History */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {snapshots.length === 0 ? (
            <p className="text-sm text-gray-500">No data synced yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Replies</TableHead>
                  <TableHead>Bounces</TableHead>
                  <TableHead>Unsubs</TableHead>
                  <TableHead>Positive</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.slice(0, 14).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.snapshot_date}</TableCell>
                    <TableCell>{s.emails_sent}</TableCell>
                    <TableCell>{s.replies}</TableCell>
                    <TableCell>{s.bounces}</TableCell>
                    <TableCell>{s.unsubscribes}</TableCell>
                    <TableCell>{s.meetings_booked}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Lead Feedback */}
      <Card>
        <CardHeader>
          <CardTitle>Lead Feedback ({feedback.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {feedback.length === 0 ? (
            <p className="text-sm text-gray-500">No feedback submitted yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Comment</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {feedback.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{f.lead_email}</p>
                        {f.lead_company && (
                          <p className="text-xs text-gray-500">{f.lead_company}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{f.status.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell className="max-w-xs truncate">
                      {f.comment || "—"}
                    </TableCell>
                    <TableCell className="text-sm text-gray-500">
                      {new Date(f.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
