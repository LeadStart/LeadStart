"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Eye, Monitor, Smartphone } from "lucide-react";
import { buildWeeklyReportEmail } from "@/lib/email/weekly-report";

// Inline sample data so the preview renders without having to send a real
// report. Kept minimal — just enough to exercise every section of the email
// template (single campaign row + totals).
const SAMPLE_REPORT_DATA = {
  client_name: "Acme Corp",
  period: { start: "2025-03-01", end: "2025-03-15" },
  campaigns: [
    {
      campaign_name: "Acme — Commercial RE Investors Q1",
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
        reply_rate: 15.51,
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
  const emailHtml = buildWeeklyReportEmail(reportData, "https://app.leadstart.com/client");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Email Templates</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Weekly KPI Report Preview</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            This is what clients see when you send a weekly report
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            <Eye size={12} className="mr-1" />
            Preview Mode
          </Badge>
          <span className="text-sm text-muted-foreground">
            Using sample data for: <strong>{reportData.client_name}</strong>
          </span>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border/50 p-1">
          <button
            onClick={() => setViewport("desktop")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              viewport === "desktop"
                ? "bg-[#2E37FE]/20 text-[#6B72FF]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Monitor size={13} />
            Desktop
          </button>
          <button
            onClick={() => setViewport("mobile")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              viewport === "mobile"
                ? "bg-[#2E37FE]/20 text-[#6B72FF]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Smartphone size={13} />
            Mobile
          </button>
        </div>
      </div>

      {/* Email Preview Frame */}
      <Card className="border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="bg-muted/30 border-b border-border/30 py-3 px-4">
          <div className="flex items-center gap-3 text-sm">
            <div className="flex gap-1.5">
              <span className="h-3 w-3 rounded-full bg-red-400" />
              <span className="h-3 w-3 rounded-full bg-amber-400" />
              <span className="h-3 w-3 rounded-full bg-emerald-400" />
            </div>
            <div className="flex-1 text-center">
              <span className="text-xs text-muted-foreground bg-muted rounded px-3 py-1">
                Weekly Campaign Report — {reportData.client_name}
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
