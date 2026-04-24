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
  Users,
  Settings2,
  Save,
} from "lucide-react";
import { buildWeeklyReportEmail } from "@/lib/email/weekly-report";
import { calculateMetrics } from "@/lib/kpi/calculator";
import type { Client, Campaign, CampaignSnapshot, KPIReport, ReportFrequency } from "@/types/app";
import {
  WEEKDAY_LABELS,
  COMMON_TIMEZONES,
  describeSchedule,
  frequencyBadgeLabel,
} from "@/lib/kpi/schedule";
import { appUrl } from "@/lib/api-url";

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
  const [sending, setSending] = useState(false);
  const [sendSuccess, setSendSuccess] = useState(false);
  const [recipients, setRecipients] = useState<{ email: string; name: string; checked: boolean; source: string }[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);

  // Schedule editing state
  const [editingScheduleClient, setEditingScheduleClient] = useState<Client | null>(null);
  const [scheduleFrequency, setScheduleFrequency] = useState<"off" | ReportFrequency>("off");
  const [scheduleDayOfWeek, setScheduleDayOfWeek] = useState<number>(5); // Friday default
  const [scheduleDayOfMonth, setScheduleDayOfMonth] = useState<number>(1);
  const [scheduleTimeOfDay, setScheduleTimeOfDay] = useState<string>("10:00");
  const [scheduleTimezone, setScheduleTimezone] = useState<string>("America/New_York");
  const [scheduleRecipients, setScheduleRecipients] = useState<{ email: string; name: string; checked: boolean; source: string }[]>([]);
  const [loadingScheduleRecipients, setLoadingScheduleRecipients] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

  async function openScheduleEditor(client: Client) {
    setEditingScheduleClient(client);
    setScheduleFrequency(client.report_frequency ?? "off");
    setScheduleDayOfWeek(client.report_day_of_week ?? 5);
    setScheduleDayOfMonth(client.report_day_of_month ?? 1);
    setScheduleTimeOfDay(client.report_time_of_day ?? "10:00");
    setScheduleTimezone(
      client.report_timezone ??
        (typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"
          : "America/New_York")
    );
    // Load recipients for this client
    setLoadingScheduleRecipients(true);
    const supabase = createClient();
    const list: typeof scheduleRecipients = [];

    if (client.contact_email) {
      list.push({
        email: client.contact_email,
        name: client.name,
        checked: client.report_recipients?.includes(client.contact_email) ?? true,
        source: "Client Contact",
      });
    }

    const { data: cuData } = await supabase
      .from("client_users")
      .select("user_id")
      .eq("client_id", client.id);

    if (cuData && cuData.length > 0) {
      const userIds = cuData.map((cu: { user_id: string }) => cu.user_id);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .in("id", userIds);

      for (const p of (profiles || []) as { id: string; email: string; full_name: string | null }[]) {
        if (!list.some((r) => r.email === p.email)) {
          list.push({
            email: p.email,
            name: p.full_name || p.email,
            checked: client.report_recipients?.includes(p.email) ?? true,
            source: "Portal User",
          });
        }
      }
    }

    // If there are saved recipients not in the list, add them
    if (client.report_recipients) {
      for (const email of client.report_recipients) {
        if (!list.some((r) => r.email === email)) {
          list.push({ email, name: email, checked: true, source: "Saved" });
        }
      }
    }

    setScheduleRecipients(list);
    setLoadingScheduleRecipients(false);
  }

  async function saveSchedule() {
    if (!editingScheduleClient) return;
    setSavingSchedule(true);

    const selectedRecipients = scheduleRecipients
      .filter((r) => r.checked)
      .map((r) => r.email);

    const isOff = scheduleFrequency === "off";
    const payload: Record<string, unknown> = {
      client_id: editingScheduleClient.id,
      frequency: isOff ? null : scheduleFrequency,
      recipients: selectedRecipients,
    };

    if (!isOff) {
      payload.time_of_day = scheduleTimeOfDay;
      payload.timezone = scheduleTimezone;
      if (scheduleFrequency === "weekly" || scheduleFrequency === "biweekly") {
        payload.day_of_week = scheduleDayOfWeek;
        payload.day_of_month = null;
      } else if (scheduleFrequency === "monthly") {
        payload.day_of_month = scheduleDayOfMonth;
        payload.day_of_week = null;
      }
      // For biweekly, stamp today as the anchor if one isn't already set so
      // the on/off-week cadence is deterministic from here forward.
      if (
        scheduleFrequency === "biweekly" &&
        !editingScheduleClient.report_schedule_start
      ) {
        payload.schedule_start = new Date().toISOString().split("T")[0];
      }
    }

    try {
      const res = await fetch(appUrl("/api/admin/report-schedule"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save schedule");
      }

      // Update local state
      setClients((prev) =>
        prev.map((c) =>
          c.id === editingScheduleClient.id
            ? {
                ...c,
                report_frequency: isOff ? null : scheduleFrequency,
                report_day_of_week: isOff
                  ? null
                  : scheduleFrequency === "monthly"
                    ? null
                    : scheduleDayOfWeek,
                report_day_of_month: isOff
                  ? null
                  : scheduleFrequency === "monthly"
                    ? scheduleDayOfMonth
                    : null,
                report_time_of_day: isOff ? null : scheduleTimeOfDay,
                report_timezone: isOff ? null : scheduleTimezone,
                report_schedule_start:
                  !isOff &&
                  scheduleFrequency === "biweekly" &&
                  !c.report_schedule_start
                    ? (payload.schedule_start as string)
                    : c.report_schedule_start,
                report_recipients: selectedRecipients.length > 0 ? selectedRecipients : null,
              }
            : c
        )
      );
      setEditingScheduleClient(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingSchedule(false);
    }
  }

  async function loadRecipients(clientId: string) {
    setLoadingRecipients(true);
    const supabase = createClient();
    const list: { email: string; name: string; checked: boolean; source: string }[] = [];

    // Add contact_email from client record
    const client = clients.find((c) => c.id === clientId);
    if (client?.contact_email) {
      list.push({ email: client.contact_email, name: client.name, checked: true, source: "Client Contact" });
    }

    // Add portal users from client_users → profiles
    const { data: cuData } = await supabase
      .from("client_users")
      .select("user_id")
      .eq("client_id", clientId);

    if (cuData && cuData.length > 0) {
      const userIds = cuData.map((cu: { user_id: string }) => cu.user_id);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .in("id", userIds);

      for (const p of (profiles || []) as { id: string; email: string; full_name: string | null }[]) {
        // Don't duplicate if same as contact_email
        if (!list.some((r) => r.email === p.email)) {
          list.push({ email: p.email, name: p.full_name || p.email, checked: true, source: "Portal User" });
        }
      }
    }

    setRecipients(list);
    setLoadingRecipients(false);
  }

  async function handleSendReport(report: KPIReport) {
    const checkedRecipients = recipients.filter((r) => r.checked).map((r) => r.email);
    if (checkedRecipients.length === 0) {
      setError("Select at least one recipient");
      return;
    }

    setSending(true);
    setSendSuccess(false);
    setError(null);

    try {
      const res = await fetch(appUrl("/api/cron/send-reports"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: report.id, recipients: checkedRecipients }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to send report");
      }

      setSendSuccess(true);
      setReports((prev) =>
        prev.map((r) =>
          r.id === report.id
            ? { ...r, sent_at: new Date().toISOString(), sent_to: checkedRecipients }
            : r
        )
      );
      setSelectedReport((prev) =>
        prev && prev.id === report.id
          ? { ...prev, sent_at: new Date().toISOString(), sent_to: checkedRecipients }
          : prev
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send report");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    const supabase = createClient();
    supabase.from("clients").select("*").order("name").then(({ data }: { data: unknown }) => {
      setClients((data || []) as Client[]);
    });
    supabase
      .from("kpi_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20)
      .then(({ data }: { data: unknown }) => {
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

      // Save draft to database so it gets a real ID
      const reportData = {
        client_name: client.name,
        period: { start: startDate, end: endDate },
        campaigns: campaignSummaries,
        totals,
      };

      const { data: inserted, error: insertError } = await supabase
        .from("kpi_reports")
        .insert({
          client_id: selectedClient,
          organization_id: client.organization_id,
          report_period_start: startDate,
          report_period_end: endDate,
          report_data: reportData,
        })
        .select()
        .single();

      if (insertError) throw new Error(insertError.message);

      const draftReport: KPIReport = {
        ...(inserted as unknown as KPIReport),
        report_data: reportData,
      };

      // Add to reports list and immediately open preview
      setReports((prev) => [draftReport, ...prev]);
      setSelectedReport(draftReport);
      setShowPreview(false);
      loadRecipients(selectedClient);
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
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Client Reporting</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>KPI Reports</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            {reports.length} total &middot; {sentCount} sent &middot; {draftCount} draft
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Report Builder */}
      <Card className="border-border/50">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Send size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">Generate Report</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Creates a draft for review — send when ready</p>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,200px)_minmax(0,180px)_minmax(0,160px)_minmax(0,160px)_auto]">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Client</Label>
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
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Quick Select</Label>
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
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Start Date</Label>
              <Input
                style={{ height: '36px' }}
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">End Date</Label>
              <Input
                style={{ height: '36px' }}
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <div className="flex items-end sm:col-span-2 lg:col-span-1">
              <Button className="w-full" style={{ height: '36px' }} onClick={handleGenerate} disabled={generating} variant="outline">
                {generating ? "Generating..." : "Generate Draft"}
              </Button>
            </div>
          </div>
          {error && (
            <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-Client Auto Report Schedule */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50">
            <Clock size={16} className="text-amber-500" />
          </div>
          <div>
            <CardTitle className="text-base">Automated Report Schedules</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Configure per-client auto-send schedules</p>
          </div>
        </CardHeader>
        <CardContent>
          {clients.length === 0 ? (
            <p className="text-sm text-muted-foreground">No clients to configure.</p>
          ) : (
            <div className="space-y-3">
              {clients.map((client) => {
                const reportCount = reports.filter((r) => r.client_id === client.id && r.sent_at).length;
                const hasSchedule = !!client.report_frequency;
                const recipientCount = client.report_recipients?.length || 0;
                const scheduleSummary = describeSchedule(client);

                return (
                  <div key={client.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-border/50 p-4 hover:bg-muted/20 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0" style={{ background: '#2E37FE' }}>
                        {client.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{client.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {client.contact_email || "No email"} &middot; {reportCount} report{reportCount !== 1 ? "s" : ""} sent
                        </p>
                        {scheduleSummary && (
                          <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                            {scheduleSummary}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                      {hasSchedule ? (
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge className="badge-green text-[10px]">
                            {frequencyBadgeLabel(client.report_frequency!)}
                          </Badge>
                          {recipientCount > 0 && (
                            <Badge variant="secondary" className="text-[10px]">
                              <Mail size={9} className="mr-1" />{recipientCount}
                            </Badge>
                          )}
                          {client.report_last_sent_at && (
                            <span className="text-[10px] text-muted-foreground">
                              Last: {new Date(client.report_last_sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                            </span>
                          )}
                        </div>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] text-muted-foreground">
                          Not scheduled
                        </Badge>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs px-2 ml-auto sm:ml-0"
                        onClick={() => openScheduleEditor(client)}
                      >
                        <Settings2 size={12} className="mr-1" />
                        Configure
                      </Button>
                    </div>
                  </div>
                );
              })}
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
                <p className="text-xs text-blue-700">
                  Scheduled reports auto-generate and send KPI summaries for the trailing period. The cron runs <strong>every hour</strong> and fires for each client when the current hour + day matches their configured schedule in their timezone.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Schedule Editor Dialog */}
      {editingScheduleClient && (
        <Dialog open={!!editingScheduleClient} onOpenChange={() => setEditingScheduleClient(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Settings2 size={18} className="text-[#2E37FE]" />
                Schedule — {editingScheduleClient.name}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-5 mt-2">
              {/* Frequency */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Frequency</Label>
                <Select
                  value={scheduleFrequency}
                  onValueChange={(val) => setScheduleFrequency((val ?? "off") as "off" | ReportFrequency)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Off — no auto-send" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off — no auto-send</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Biweekly (every other week)</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Day picker — weekly/biweekly */}
              {(scheduleFrequency === "weekly" || scheduleFrequency === "biweekly") && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Day of Week</Label>
                  <Select
                    value={String(scheduleDayOfWeek)}
                    onValueChange={(val) => {
                      if (val != null) setScheduleDayOfWeek(parseInt(val, 10));
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAY_LABELS.map((d) => (
                        <SelectItem key={d.value} value={String(d.value)}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Day picker — monthly */}
              {scheduleFrequency === "monthly" && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Day of Month</Label>
                  <Select
                    value={String(scheduleDayOfMonth)}
                    onValueChange={(val) => {
                      if (val != null) setScheduleDayOfMonth(parseInt(val, 10));
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d}
                        </SelectItem>
                      ))}
                      <SelectItem value="-1">Last day of month</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Capped at 28 so every month is guaranteed to fire — use &quot;Last day&quot; for end-of-month cadence.
                  </p>
                </div>
              )}

              {/* Time of day + Timezone */}
              {scheduleFrequency !== "off" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Time of Day</Label>
                    <Input
                      type="time"
                      step={900}
                      value={scheduleTimeOfDay}
                      onChange={(e) => setScheduleTimeOfDay(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Timezone</Label>
                    <Select value={scheduleTimezone} onValueChange={(val) => setScheduleTimezone(val ?? "UTC")}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-[300px]">
                        {COMMON_TIMEZONES.map((tz) => (
                          <SelectItem key={tz.value} value={tz.value}>
                            {tz.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {/* Recipients */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Recipients</Label>
                {loadingScheduleRecipients ? (
                  <p className="text-xs text-muted-foreground">Loading...</p>
                ) : scheduleRecipients.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No recipients found. Add a contact email or invite portal users first.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {scheduleRecipients.map((r) => (
                      <label key={r.email} className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={r.checked}
                          onChange={() =>
                            setScheduleRecipients((prev) =>
                              prev.map((p) =>
                                p.email === r.email ? { ...p, checked: !p.checked } : p
                              )
                            )
                          }
                          className="h-4 w-4 rounded border-border accent-[#2E37FE]"
                        />
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <div className="flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold text-white shrink-0" style={{ background: '#2E37FE' }}>
                            {r.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm truncate">{r.name}</p>
                            <p className="text-xs text-muted-foreground truncate">{r.email}</p>
                          </div>
                        </div>
                        <Badge variant="secondary" className="text-[9px] shrink-0">{r.source}</Badge>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Summary */}
              {scheduleFrequency !== "off" && (() => {
                const summary = describeSchedule({
                  report_frequency: scheduleFrequency,
                  report_day_of_week:
                    scheduleFrequency === "monthly" ? null : scheduleDayOfWeek,
                  report_day_of_month:
                    scheduleFrequency === "monthly" ? scheduleDayOfMonth : null,
                  report_time_of_day: scheduleTimeOfDay,
                  report_timezone: scheduleTimezone,
                });
                const selectedCount = scheduleRecipients.filter((r) => r.checked).length;
                const periodLabel =
                  scheduleFrequency === "weekly" ? "7-day"
                    : scheduleFrequency === "biweekly" ? "14-day"
                      : "30-day";
                return (
                  <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
                    <p className="text-xs text-blue-700">
                      {summary ?? "Incomplete schedule"} — sends to <strong>{selectedCount} recipient(s)</strong>. Each report covers the trailing {periodLabel} period.
                    </p>
                  </div>
                );
              })()}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditingScheduleClient(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={saveSchedule}
                  disabled={savingSchedule}
                  style={{ background: '#2E37FE' }}
                  className="text-white"
                >
                  <Save size={14} className="mr-1" />
                  {savingSchedule ? "Saving..." : "Save Schedule"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Report History */}
      <Card className="border-border/50">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <FileText size={16} className="text-white" />
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
                    onClick={() => { setSelectedReport(report); loadRecipients(report.client_id); }}
                    className="group cursor-pointer flex items-center justify-between rounded-xl border border-border/50 p-4 transition-all hover:border-[#2E37FE]/20 hover:shadow-md"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0" style={{ background: '#2E37FE' }}>
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
                          <Badge className="badge-green">
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
                          <Badge variant="secondary" className="badge-amber">
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
                <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-[#0f172a]" style={{ background: '#2E37FE' }}>
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
                    <Badge className="badge-green">
                      <CheckCircle size={12} className="mr-1" />
                      Sent
                    </Badge>
                  ) : (
                    <Badge className="badge-amber">
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
                    <Button
                      size="sm"
                      className="text-xs"
                      style={{ background: '#2E37FE' }}
                      onClick={() => handleSendReport(selectedReport)}
                      disabled={sending}
                    >
                      <Send size={13} className="mr-1" />
                      {sending ? "Sending..." : "Send"}
                    </Button>
                  )}
                  {selectedReport.sent_at && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => handleSendReport(selectedReport)}
                      disabled={sending}
                    >
                      <Send size={13} className="mr-1" />
                      {sending ? "Sending..." : "Resend"}
                    </Button>
                  )}
                  {sendSuccess && (
                    <span className="text-xs text-emerald-600 flex items-center gap-1">
                      <CheckCircle size={12} /> Sent!
                    </span>
                  )}
                </div>
              </div>

              {/* Recipients */}
              <div className="rounded-xl border border-border/50 bg-muted/10 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Users size={14} className="text-[#2E37FE]" />
                  <span className="text-sm font-semibold">Recipients</span>
                  <span className="text-xs text-muted-foreground">
                    ({recipients.filter((r) => r.checked).length} selected)
                  </span>
                </div>
                {loadingRecipients ? (
                  <p className="text-xs text-muted-foreground">Loading recipients...</p>
                ) : recipients.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No recipients found. Add a contact email or portal user to this client.</p>
                ) : (
                  <div className="space-y-2">
                    {recipients.map((r) => (
                      <label key={r.email} className="flex items-center gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={r.checked}
                          onChange={() =>
                            setRecipients((prev) =>
                              prev.map((p) =>
                                p.email === r.email ? { ...p, checked: !p.checked } : p
                              )
                            )
                          }
                          className="h-4 w-4 rounded border-border accent-[#2E37FE]"
                        />
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <div className="flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-bold text-white shrink-0" style={{ background: '#2E37FE' }}>
                            {r.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{r.name}</p>
                            <p className="text-xs text-muted-foreground truncate">{r.email}</p>
                          </div>
                        </div>
                        <Badge variant="secondary" className="text-[9px] shrink-0">{r.source}</Badge>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* KPI Summary */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="text-center p-3 rounded-lg bg-[#2E37FE]/5 border border-[#2E37FE]/10">
                  <p className="text-xl font-bold text-[#6B72FF]">{selectedReport.report_data.totals.emails_sent.toLocaleString()}</p>
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
                    style={{ width: "100%", height: "700px", border: "none", background: "#f8fafc" }}
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
