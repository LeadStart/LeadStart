"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText, TrendingUp, TrendingDown, Minus, Calendar, Mail } from "lucide-react";
import type { KPIReport, Client } from "@/types/app";

function MetricRow({ label, value, unit, trend }: { label: string; value: number; unit: string; trend?: "up" | "down" | "flat" }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{unit === "percent" ? `${value}%` : value.toLocaleString()}</span>
        {trend === "up" && <TrendingUp size={13} className="text-emerald-500" />}
        {trend === "down" && <TrendingDown size={13} className="text-red-500" />}
        {trend === "flat" && <Minus size={13} className="text-amber-500" />}
      </div>
    </div>
  );
}

export default function ClientReportsPage() {
  const [reports, setReports] = useState<KPIReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data: clientData } = await supabase.from("clients").select("*").eq("user_id", user.id).single();
      if (!clientData) { setLoading(false); return; }
      const client = clientData as Client;
      const { data: reportsData } = await supabase.from("kpi_reports").select("*").eq("client_id", client.id).order("created_at", { ascending: false });
      setReports((reportsData || []) as KPIReport[]);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="rounded-xl h-64 bg-muted/50" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Performance History</p>
          <h1 className="text-2xl font-bold mt-1">KPI Reports</h1>
          <p className="text-sm text-white/60 mt-1">{reports.length} report{reports.length !== 1 ? "s" : ""} delivered</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>

      {reports.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center space-y-2">
            <div className="flex justify-center"><div className="h-12 w-12 rounded-full bg-indigo-50 flex items-center justify-center"><FileText size={24} className="text-indigo-400" /></div></div>
            <p className="text-muted-foreground font-medium">No reports yet</p>
            <p className="text-sm text-muted-foreground">Your first KPI report will appear here once generated.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {reports.map((report) => {
            const { totals, period, campaigns } = report.report_data;
            const wasSent = !!report.sent_at;
            return (
              <Card key={report.id} className="border-border/50 shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-6 py-3 bg-muted/30 border-b border-border/30">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50"><FileText size={16} className="text-indigo-500" /></div>
                    <div>
                      <p className="text-sm font-semibold">{new Date(period.start).toLocaleDateString("en-US", { month: "short", day: "numeric" })} — {new Date(period.end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>
                      <p className="text-xs text-muted-foreground">{campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""} included</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {wasSent ? <Badge className="bg-emerald-100 text-emerald-700 border border-emerald-200"><Mail size={11} className="mr-1" />Delivered</Badge> : <Badge className="bg-amber-100 text-amber-700 border border-amber-200">Draft</Badge>}
                    {report.sent_at && <span className="text-xs text-muted-foreground flex items-center gap-1"><Calendar size={11} />{new Date(report.sent_at).toLocaleDateString()}</span>}
                  </div>
                </div>
                <CardContent className="pt-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                    <div className="text-center p-3 rounded-lg bg-indigo-50/50"><p className="text-xl font-bold text-indigo-700">{totals.emails_sent.toLocaleString()}</p><p className="text-xs text-muted-foreground">Emails Sent</p></div>
                    <div className="text-center p-3 rounded-lg bg-emerald-50/50"><p className="text-xl font-bold text-emerald-700">{totals.reply_rate}%</p><p className="text-xs text-muted-foreground">Reply Rate</p></div>
                    <div className="text-center p-3 rounded-lg bg-amber-50/50"><p className="text-xl font-bold text-amber-700">{totals.meetings_booked}</p><p className="text-xs text-muted-foreground">Positive Responses</p></div>
                    <div className="text-center p-3 rounded-lg bg-blue-50/50"><p className="text-xl font-bold text-blue-700">{totals.positive_reply_rate}%</p><p className="text-xs text-muted-foreground">Positive Rate</p></div>
                  </div>
                  {campaigns.map((camp) => (
                    <div key={camp.campaign_id} className="rounded-xl border border-border/50 p-4 mt-3">
                      <p className="text-sm font-semibold mb-2">{camp.campaign_name}</p>
                      <MetricRow label="Emails Sent" value={camp.metrics.emails_sent} unit="count" />
                      <MetricRow label="Reply Rate" value={camp.metrics.reply_rate} unit="percent" trend={camp.metrics.reply_rate >= 5 ? "up" : "down"} />
                      <MetricRow label="Positive Reply Rate" value={camp.metrics.positive_reply_rate} unit="percent" trend={camp.metrics.positive_reply_rate >= 30 ? "up" : "flat"} />
                      <MetricRow label="Positive Responses" value={camp.metrics.meetings_booked} unit="count" trend="up" />
                      <MetricRow label="Reply → Meeting" value={camp.metrics.reply_to_meeting_rate} unit="percent" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
