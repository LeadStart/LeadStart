"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useClientData } from "../client-data-context";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText, TrendingUp, TrendingDown, Minus, Calendar, Mail } from "lucide-react";
import type { KPIReport } from "@/types/app";

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
  const { client, loading: contextLoading } = useClientData();
  const [reports, setReports] = useState<KPIReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (contextLoading || !client) return;
    const supabase = createClient();
    supabase.from("kpi_reports").select("*").eq("client_id", client.id).order("created_at", { ascending: false })
      .then(({ data: reportsData }) => {
        setReports((reportsData || []) as KPIReport[]);
        setLoading(false);
      });
  }, [contextLoading, client]);

  if (contextLoading || loading) {
    return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="rounded-xl h-64 bg-muted/50" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EBF5FE 0%, #D6ECFB 50%, #fff 100%)', border: '1px solid rgba(30,143,232,0.2)', borderTop: '1px solid rgba(30,143,232,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(30,143,232,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Performance History</p>
          <h1 className="text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>KPI Reports</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">{reports.length} report{reports.length !== 1 ? "s" : ""} delivered</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(71,165,237,0.06)]" />
      </div>

      {reports.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center space-y-2">
            <div className="flex justify-center"><div className="h-12 w-12 rounded-full bg-[#1E8FE8]/10 flex items-center justify-center"><FileText size={24} className="text-[#1878C8]" /></div></div>
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
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E8FE8]/10"><FileText size={16} className="text-[#1E8FE8]" /></div>
                    <div>
                      <p className="text-sm font-semibold">{new Date(period.start).toLocaleDateString("en-US", { month: "short", day: "numeric" })} — {new Date(period.end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>
                      <p className="text-xs text-muted-foreground">{campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""} included</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {wasSent ? <Badge className="badge-green"><Mail size={11} className="mr-1" />Delivered</Badge> : <Badge className="badge-amber">Draft</Badge>}
                    {report.sent_at && <span className="text-xs text-muted-foreground flex items-center gap-1"><Calendar size={11} />{new Date(report.sent_at).toLocaleDateString()}</span>}
                  </div>
                </div>
                <CardContent className="pt-4">
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="text-center p-3 rounded-lg bg-[#1E8FE8]/5"><p className="text-xl font-bold text-[#47A5ED]">{totals.emails_sent.toLocaleString()}</p><p className="text-xs text-muted-foreground">Emails Sent</p></div>
                    <div className="text-center p-3 rounded-lg bg-emerald-50/50"><p className="text-xl font-bold text-emerald-700">{totals.meetings_booked}</p><p className="text-xs text-muted-foreground">Positive Responses</p></div>
                  </div>
                  {campaigns.map((camp) => (
                    <div key={camp.campaign_id} className="rounded-xl border border-border/50 p-4 mt-3">
                      <p className="text-sm font-semibold mb-2">{camp.campaign_name}</p>
                      <MetricRow label="Emails Sent" value={camp.metrics.emails_sent} unit="count" />
                      <MetricRow label="Positive Responses" value={camp.metrics.meetings_booked} unit="count" trend="up" />
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
