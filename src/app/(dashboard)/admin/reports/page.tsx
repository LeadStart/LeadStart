"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  FileText,
  Send,
  Calendar,
  Mail,
  Clock,
  ArrowRight,
  Eye,
  ArrowLeft,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import { buildWeeklyReportEmail } from "@/lib/email/weekly-report";
import { calculateMetrics } from "@/lib/kpi/calculator";
import type { Client, Campaign, CampaignSnapshot, KPIReport } from "@/types/app";

export default function ReportsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [reports, setReports] = useState<KPIReport[]>([]);
  const [selectedClient, setSelectedClient] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<KPIReport | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.from("clients").select("*").order("name").then(({ data }) => {
      setClients((data || []) as Client[]);
    });
    supabase
      .from("kpi_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20)
      .then(({ data }) => {
        setReports((data || []) as KPIReport[]);
      });
  }, []);

  async function handleGenerate() {
    if (!selectedClient || !startDate || !endDate) return;

    setGenerating(true);
    setError(null);

    try {
      const supabase = createClient();

      // Get the client
      const { data: clientData } = await supabase
        .from("clients")
        .select("*")
        .eq("id", selectedClient)
        .single();
      const client = clientData as Client | null;
      if (!client) throw new Error("Client not found");

      // Get campaigns for this client
      const { data: campaignsData } = await supabase
        .from("campaigns")
        .select("*")
        .eq("client_id", selectedClient);
      const campaigns = (campaignsData || []) as Campaign[];

      // Get snapshots for these campaigns in the date range
      const campaignIds = campaigns.map((c) => c.id);
      const { data: snapshotsData } = await supabase
        .from("campaign_snapshots")
        .select("*")
        .in("campaign_id", campaignIds.length > 0 ? campaignIds : ["none"])
        .gte("snapshot_date", startDate)
        .lte("snapshot_date", endDate);
      const snapshots = (snapshotsData || []) as CampaignSnapshot[];

      // Build per-campaign metrics
      const campaignSummaries = campaigns.map((camp) => {
        const campSnaps = snapshots.filter((s) => s.campaign_id === camp.id);
        const metrics = calculateMetrics(campSnaps);
        return {
          campaign_name: camp.name,
          campaign_id: camp.id,
          metrics,
        };
      }).filter((c) => c.metrics.emails_sent > 0);

      const totals = calculateMetrics(snapshots);

      // Build the draft report
      const draftReport: KPIReport = {
        id: `draft-${Date.now()}`,
        client_id: selectedClient,
        organization_id: client.organization_id,
        report_period_start: startDate,
        report_period_end: endDate,
        report_data: {
          client_name: client.name,
          period: { start: startDate, end: endDate },
          campaigns: campaignSummaries,
          totals,
        },
        sent_at: null,
        sent_to: null,
        created_by: null,
        created_at: new Date().toISOString(),
      };

      // Add to reports list and immediately open preview
      setReports((prev) => [draftReport, ...prev]);
      setSelectedReport(draftReport);
      setShowPreview(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  const clientMap = new Map(clients.map((c) => [c.id, c]));

  const sentCount = reports.filter((r) => r.sent_at).length;
  const draftCount = reports.filter((r) => !r.sent_at).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Client Reporting</p>
          <h1 className="text-2xl font-bold mt-1">KPI Reports</h1>
          <p className="text-sm text-white/60 mt-1">
            {reports.length} total &middot; {sentCount} sent &middot; {draftCount} draft
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>

      {/* Report Builder */}
      <Card className="border-border/50">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <Send size={16} className="text-indigo-500" />
          </div>
          <div>
            <CardTitle className="text-base">Generate Report</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Creates a draft for review — send when ready</p>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: '200px 180px 160px 160px auto' }}>
            <Label className="text-sm font-medium">Client</Label>
            <Label className="text-sm font-medium">Quick Select</Label>
            <Label className="text-sm font-medium">Start Date</Label>
            <Label className="text-sm font-medium">End Date</Label>
            <div />
            <Select value={selectedClient} onValueChange={(val) => setSelectedClient(val ?? "")}>
              <SelectTrigger className="w-full" style={{ height: '36px' }}>
                <SelectValue placeholder="Select client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value=""
              onValueChange={(val) => {
                const today = new Date();
                let start: Date;
                let end: Date;
                if (val === "7d") {
                  end = today;
                  start = new Date(today);
                  start.setDate(start.getDate() - 7);
                } else if (val === "last_month") {
                  start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                  end = new Date(today.getFullYear(), today.getMonth(), 0);
                } else if (val === "mtd") {
                  start = new Date(today.getFullYear(), today.getMonth(), 1);
                  end = today;
                } else if (val === "30d") {
                  end = today;
                  start = new Date(today);
                  start.setDate(start.getDate() - 30);
                } else {
                  return;
                }
                setStartDate(start.toISOString().split("T")[0]);
                setEndDate(end.toISOString().split("T")[0]);
              }}
            >
              <SelectTrigger className="w-full" style={{ height: '36px' }}>
                <SelectValue placeholder="Choose range..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7d">Last 7 Days</SelectItem>
                <SelectItem value="last_month">Last Calendar Month</SelectItem>
                <SelectItem value="mtd">Month to Date</SelectItem>
                <SelectItem value="30d">Last 30 Days</SelectItem>
              </SelectContent>
            </Select>
            <Input
              style={{ height: '36px' }}
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <Input
              style={{ height: '36px' }}
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
            <Button style={{ height: '36px' }} onClick={handleGenerate} disabled={generating} variant="outline">
              {generating ? "Generating..." : "Generate Draft"}
            </Button>
          </div>
          {error && (
            <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Report History */}
      <Card className="border-border/50">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <FileText size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Report History</CardTitle>
        </CardHeader>
        <CardContent>
          {reports.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reports generated yet.</p>
          ) : (
            <div className="space-y-2">
              {reports.map((report) => {
                const client = clientMap.get(report.client_id);
                const wasSent = !!report.sent_at;

                return (
                  <div
                    key={report.id}
                    onClick={() => setSelectedReport(report)}
                    className="group cursor-pointer flex items-center justify-between rounded-xl border border-border/50 p-4 transition-all hover:border-indigo-200 hover:shadow-md"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
                        {client?.name?.charAt(0) || "?"}
                      </div>
                      <div>
                        <p className="font-medium">{client?.name || "Unknown"}</p>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Calendar size={11} />
                            {report.report_period_start} — {report.report_period_end}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {wasSent ? (
                        <div className="text-right">
                          <Badge className="bg-emerald-100 text-emerald-700 border border-emerald-200">
                            <CheckCircle size={11} className="mr-1" />
                            Sent
                          </Badge>
                          <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1 justify-end">
                            <Clock size={9} />
                            {new Date(report.sent_at!).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </p>
                          {report.sent_to && (
                            <p className="text-[10px] text-muted-foreground flex items-center gap-1 justify-end">
                              <Mail size={9} />
                              {report.sent_to.join(", ")}
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="text-right">
                          <Badge variant="secondary" className="bg-amber-100 text-amber-700 border border-amber-200">
                            <AlertCircle size={11} className="mr-1" />
                            Draft
                          </Badge>
                          <p className="text-[10px] text-muted-foreground mt-1">
                            Not yet sent
                          </p>
                        </div>
                      )}
                      <ArrowRight size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Report Detail Dialog */}
      {selectedReport && (
        <Dialog open={!!selectedReport} onOpenChange={() => { setSelectedReport(null); setShowPreview(false); }}>
          <DialogContent className="w-[85vw] max-w-5xl min-h-[75vh] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
                  {clientMap.get(selectedReport.client_id)?.name?.charAt(0) || "?"}
                </div>
                <div>
                  <span>{clientMap.get(selectedReport.client_id)?.name || "Unknown"}</span>
                  <p className="text-xs font-normal text-muted-foreground mt-0.5">
                    {selectedReport.report_period_start} — {selectedReport.report_period_end}
                  </p>
                </div>
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 mt-2">
              {/* Status bar */}
              <div className="rounded-xl border border-border/50 bg-muted/20 p-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  {selectedReport.sent_at ? (
                    <Badge className="bg-emerald-100 text-emerald-700 border border-emerald-200">
                      <CheckCircle size={12} className="mr-1" />
                      Sent
                    </Badge>
                  ) : (
                    <Badge className="bg-amber-100 text-amber-700 border border-amber-200">
                      <AlertCircle size={12} className="mr-1" />
                      Draft
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock size={11} />
                    Created {new Date(selectedReport.created_at).toLocaleDateString()}
                  </span>
                  {selectedReport.sent_at && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Send size={11} />
                      Sent {new Date(selectedReport.sent_at).toLocaleDateString()}
                    </span>
                  )}
                  {selectedReport.sent_to && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Mail size={11} />
                      {selectedReport.sent_to.join(", ")}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => setShowPreview(!showPreview)}
                  >
                    <Eye size={13} className="mr-1" />
                    {showPreview ? "Hide Preview" : "Email Preview"}
                  </Button>
                  {!selectedReport.sent_at && (
                    <Button size="sm" className="text-xs" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
                      <Send size={13} className="mr-1" />
                      Send
                    </Button>
                  )}
                  {selectedReport.sent_at && (
                    <Button variant="outline" size="sm" className="text-xs">
                      <Send size={13} className="mr-1" />
                      Resend
                    </Button>
                  )}
                </div>
              </div>

              {/* KPI Summary */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="text-center p-3 rounded-lg bg-indigo-50/50 border border-indigo-100">
                  <p className="text-xl font-bold text-indigo-700">{selectedReport.report_data.totals.emails_sent.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Emails Sent</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-emerald-50/50 border border-emerald-100">
                  <p className="text-xl font-bold text-emerald-700">{selectedReport.report_data.totals.reply_rate}%</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Reply Rate</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-amber-50/50 border border-amber-100">
                  <p className="text-xl font-bold">{selectedReport.report_data.totals.meetings_booked}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Positive Responses</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-blue-50/50 border border-blue-100">
                  <p className="text-xl font-bold text-blue-700">{selectedReport.report_data.totals.positive_reply_rate}%</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Positive Rate</p>
                </div>
              </div>

              {/* Campaign breakdown */}
              {selectedReport.report_data.campaigns.map((camp) => (
                <div key={camp.campaign_id} className="rounded-xl border border-border/50 p-4">
                  <p className="text-sm font-semibold mb-2">{camp.campaign_name}</p>
                  <div className="grid grid-cols-4 gap-4 text-center">
                    <div>
                      <p className="text-sm font-bold">{camp.metrics.emails_sent.toLocaleString()}</p>
                      <p className="text-[10px] text-muted-foreground uppercase">Sent</p>
                    </div>
                    <div>
                      <p className={`text-sm font-bold ${camp.metrics.reply_rate >= 5 ? "text-emerald-700" : "text-amber-700"}`}>
                        {camp.metrics.reply_rate}%
                      </p>
                      <p className="text-[10px] text-muted-foreground uppercase">Reply</p>
                    </div>
                    <div>
                      <p className={`text-sm font-bold ${camp.metrics.bounce_rate <= 2 ? "text-emerald-700" : "text-red-700"}`}>
                        {camp.metrics.bounce_rate}%
                      </p>
                      <p className="text-[10px] text-muted-foreground uppercase">Bounce</p>
                    </div>
                    <div>
                      <p className="text-sm font-bold">{camp.metrics.meetings_booked}</p>
                      <p className="text-[10px] text-muted-foreground uppercase">Positive</p>
                    </div>
                  </div>
                </div>
              ))}

              {/* Email Preview iframe */}
              {showPreview && (
                <div className="rounded-xl border border-border/50 overflow-hidden">
                  <div className="bg-muted/30 border-b border-border/30 py-2 px-4 flex items-center gap-3">
                    <div className="flex gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                      <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                    </div>
                    <span className="text-xs text-muted-foreground">Email as received by client</span>
                  </div>
                  <iframe
                    srcDoc={buildWeeklyReportEmail(selectedReport.report_data)}
                    style={{ width: "100%", height: "700px", border: "none", background: "#f4f4f8" }}
                    title="Email Preview"
                  />
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
