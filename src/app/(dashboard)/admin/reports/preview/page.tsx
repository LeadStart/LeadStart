"use client";
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Eye, Monitor, Smartphone } from "lucide-react";
import { buildWeeklyReportEmail, reportCadence } from "@/lib/email/weekly-report";

// Inline sample data so the preview renders without having to send a real
// report. Kept minimal: just enough to exercise every section of the email
// template (single campaign row + totals).
const SAMPLE_REPORT_DATA = {
  client_name: "Acme Corp",
  period: { start: "2025-03-01", end: "2025-03-15" },
  campaigns: [
    {
      campaign_name: "Acme, Commercial RE Investors Q1",
      campaign_id: "sample-camp-001",
      metrics: {
        emails_sent: 680,
        replies: 41,
        unique_replies: 38,
        positive_replies: 15,
        bounces: 12,
        unsubscribes: 2,
        meetings_booked: 6,
        new_leads_contacted: 245,
        reply_rate: 5.59,
        positive_reply_rate: 39.47,
        bounce_rate: 1.76,
        unsubscribe_rate: 0.29,
        reply_to_meeting_rate: 15.79,
      },
    },
  ],
  totals: {
    emails_sent: 680,
    replies: 41,
    unique_replies: 38,
    positive_replies: 15,
    bounces: 12,
    unsubscribes: 2,
    meetings_booked: 6,
    new_leads_contacted: 245,
    reply_rate: 15.51,
    positive_reply_rate: 39.47,
    bounce_rate: 1.76,
    unsubscribe_rate: 0.29,
    reply_to_meeting_rate: 15.79,
  },
};

export default function ReportPreviewPage() {
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");

  const reportData = SAMPLE_REPORT_DATA;
  const emailHtml = buildWeeklyReportEmail(reportData);

  return (
    <div className="space-y-6">
      <PageHeader
        backHref="/admin/reports"
        backLabel="Back to reports"
        title="Weekly KPI Report Preview"
      />

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-xs">
            <Eye size={12} className="mr-1" />
            Preview Mode
          </Badge>
          <span className="text-sm text-muted-foreground">
            Using sample data for: <strong>{reportData.client_name}</strong>
          </span>
        </div>
        <Tabs value={viewport} onValueChange={(v) => setViewport(v as typeof viewport)}>
          <TabsList>
            <TabsTrigger value="desktop">
              <Monitor size={13} />
              Desktop
            </TabsTrigger>
            <TabsTrigger value="mobile">
              <Smartphone size={13} />
              Mobile
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Email Preview Frame */}
      <Card className="overflow-hidden">
        <CardHeader className="bg-muted/30 border-b border-border-soft py-3 px-4">
          <div className="flex items-center gap-3 text-sm">
            <div className="flex gap-1.5">
              <span className="h-3 w-3 rounded-full bg-red-400" />
              <span className="h-3 w-3 rounded-full bg-amber-400" />
              <span className="h-3 w-3 rounded-full bg-emerald-400" />
            </div>
            <div className="flex-1 text-center">
              <span className="text-xs text-muted-foreground bg-muted rounded px-3 py-1">
                {reportCadence(reportData.period) ?? ""} Campaign Report: {reportData.client_name}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 flex justify-center bg-gray-100">
          <div
            style={{
              width: viewport === "mobile" ? "375px" : "100%",
              transition: "width 0.3s ease",
            }}
          >
            <iframe
              srcDoc={emailHtml}
              style={{
                width: "100%",
                height: "900px",
                border: "none",
                background: "#f8fafc",
              }}
              title="Email Preview"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
