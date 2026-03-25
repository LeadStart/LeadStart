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
import { useUser } from "@/hooks/use-user";
import {
  Key,
  RefreshCw,
  CheckCircle,
  XCircle,
  Zap,
  Clock,
  Mail,
  CreditCard,
  Settings2,
} from "lucide-react";
import type { Organization } from "@/types/app";

const SYNC_TIME_OPTIONS = [
  { value: "3", label: "3:00 AM ET" },
  { value: "4", label: "4:00 AM ET" },
  { value: "5", label: "5:00 AM ET" },
  { value: "6", label: "6:00 AM ET (Current)" },
  { value: "7", label: "7:00 AM ET" },
  { value: "8", label: "8:00 AM ET" },
  { value: "9", label: "9:00 AM ET" },
  { value: "12", label: "12:00 PM ET" },
  { value: "18", label: "6:00 PM ET" },
];

const REPORT_DAY_OPTIONS = [
  { value: "1", label: "Monday (Current)" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
];

const REPORT_TIME_OPTIONS = [
  { value: "8", label: "8:00 AM ET" },
  { value: "9", label: "9:00 AM ET" },
  { value: "10", label: "10:00 AM ET (Current)" },
  { value: "11", label: "11:00 AM ET" },
  { value: "12", label: "12:00 PM ET" },
  { value: "14", label: "2:00 PM ET" },
];

export default function IntegrationsPage() {
  const { organizationId } = useUser();
  const [org, setOrg] = useState<Organization | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [resendKey, setResendKey] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  const [syncHour, setSyncHour] = useState("6");
  const [reportDay, setReportDay] = useState("1");
  const [reportHour, setReportHour] = useState("10");
  const [saving, setSaving] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [savingResend, setSavingResend] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "fail" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [resendSaved, setResendSaved] = useState(false);

  useEffect(() => {
    if (!organizationId) return;
    const supabase = createClient();
    supabase
      .from("organizations")
      .select("*")
      .eq("id", organizationId)
      .single()
      .then(({ data }: { data: unknown }) => {
        if (data) {
          const typedOrg = data as Organization & {
            sync_hour?: string;
            report_day?: string;
            report_hour?: string;
            resend_api_key?: string;
            email_from?: string;
          };
          setOrg(typedOrg);
          setApiKey(typedOrg.instantly_api_key || "");
          if (typedOrg.sync_hour) setSyncHour(typedOrg.sync_hour);
          if (typedOrg.report_day) setReportDay(typedOrg.report_day);
          if (typedOrg.report_hour) setReportHour(typedOrg.report_hour);
          if (typedOrg.resend_api_key) setResendKey(typedOrg.resend_api_key);
          if (typedOrg.email_from) setEmailFrom(typedOrg.email_from);
        }
      });
  }, [organizationId]);

  async function handleSaveApiKey() {
    if (!organizationId) return;
    setSaving(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase
      .from("organizations")
      .update({ instantly_api_key: apiKey })
      .eq("id", organizationId);

    if (error) setError(error.message);
    setSaving(false);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch("/api/instantly/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
      });
      setTestResult(res.ok ? "success" : "fail");
    } catch {
      setTestResult("fail");
    } finally {
      setTesting(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);

    try {
      const res = await fetch("/api/cron/sync-analytics", { method: "POST" });
      const data = await res.json();
      setSyncResult(res.ok ? `Synced ${data.synced || 0} campaigns` : "Sync failed");
    } catch {
      setSyncResult("Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveSchedule() {
    if (!organizationId) return;
    setSavingSchedule(true);
    setScheduleSaved(false);

    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({
        sync_hour: syncHour,
        report_day: reportDay,
        report_hour: reportHour,
      })
      .eq("id", organizationId);

    setScheduleSaved(true);
    setSavingSchedule(false);
    setTimeout(() => setScheduleSaved(false), 3000);
  }

  async function handleSaveResend() {
    if (!organizationId) return;
    setSavingResend(true);
    setResendSaved(false);

    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({
        resend_api_key: resendKey,
        email_from: emailFrom,
      })
      .eq("id", organizationId);

    setResendSaved(true);
    setSavingResend(false);
    setTimeout(() => setResendSaved(false), 3000);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Settings</p>
          <h1 className="text-2xl font-bold mt-1">Integrations</h1>
          <p className="text-sm text-white/60 mt-1">
            Manage API connections, email, and sync schedules
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>

      {/* Instantly.ai API Key */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <Key size={16} className="text-indigo-500" />
          </div>
          <div>
            <CardTitle className="text-base">Instantly.ai</CardTitle>
            <p className="text-xs text-muted-foreground">Campaign data source</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="apiKey" className="text-sm font-medium">API Key</Label>
            <Input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your Instantly.ai API key"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSaveApiKey} disabled={saving} style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
              {saving ? "Saving..." : "Save Key"}
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={testing || !apiKey}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
          </div>
          {testResult === "success" && (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
              <CheckCircle size={16} className="text-emerald-500" />
              <span className="text-sm font-medium text-emerald-700">Connection successful</span>
            </div>
          )}
          {testResult === "fail" && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
              <XCircle size={16} className="text-red-500" />
              <span className="text-sm font-medium text-red-700">Connection failed — check your API key</span>
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Resend (Email) */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50">
            <Mail size={16} className="text-emerald-500" />
          </div>
          <div>
            <CardTitle className="text-base">Resend</CardTitle>
            <p className="text-xs text-muted-foreground">Email delivery for KPI reports &amp; notifications</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="resendKey" className="text-sm font-medium">API Key</Label>
              <Input
                id="resendKey"
                type="password"
                value={resendKey}
                onChange={(e) => setResendKey(e.target.value)}
                placeholder="re_xxxxxxxxxx"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="emailFrom" className="text-sm font-medium">From Address</Label>
              <Input
                id="emailFrom"
                value={emailFrom}
                onChange={(e) => setEmailFrom(e.target.value)}
                placeholder="LeadStart <reports@yourdomain.com>"
              />
              <p className="text-[11px] text-muted-foreground">Use onboarding@resend.dev for testing</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={handleSaveResend} disabled={savingResend} style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
              {savingResend ? "Saving..." : "Save Email Settings"}
            </Button>
            {resendSaved && (
              <span className="text-sm text-emerald-600 flex items-center gap-1">
                <CheckCircle size={14} /> Saved
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Sync Schedule */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50">
            <Clock size={16} className="text-amber-500" />
          </div>
          <div>
            <CardTitle className="text-base">Sync &amp; Report Schedule</CardTitle>
            <p className="text-xs text-muted-foreground">Control when data syncs and reports are sent</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Analytics Sync */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <RefreshCw size={14} className="text-muted-foreground" />
              <p className="text-sm font-medium">Daily Analytics Sync</p>
              <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 border border-emerald-200 text-[10px]">Active</Badge>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Sync Time</Label>
                <Select value={syncHour} onValueChange={(v) => v && setSyncHour(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SYNC_TIME_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">Pulls latest campaign data from Instantly</p>
              </div>
            </div>
          </div>

          <div className="h-px bg-border/50" />

          {/* Weekly Reports */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Mail size={14} className="text-muted-foreground" />
              <p className="text-sm font-medium">Weekly KPI Reports</p>
              <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 border border-emerald-200 text-[10px]">Active</Badge>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Day</Label>
                <Select value={reportDay} onValueChange={(v) => v && setReportDay(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REPORT_DAY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Time</Label>
                <Select value={reportHour} onValueChange={(v) => v && setReportHour(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REPORT_TIME_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">Auto-generates and emails last 7 days of KPIs to all clients with a contact email</p>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSaveSchedule} disabled={savingSchedule} style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
              {savingSchedule ? "Saving..." : "Save Schedule"}
            </Button>
            {scheduleSaved && (
              <span className="text-sm text-emerald-600 flex items-center gap-1">
                <CheckCircle size={14} /> Schedule saved
              </span>
            )}
          </div>

          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
            <p className="text-xs text-amber-700">
              <strong>Note:</strong> Schedule changes are saved to your settings. The Vercel cron runs daily at 6 AM ET and weekly on Mondays at 10 AM ET.
              The cron will check your saved preferences before executing. To change the actual cron trigger times, a redeployment is needed.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Manual Sync */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <Zap size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Manual Sync</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Trigger an immediate sync of all active campaign analytics from Instantly.ai.
          </p>
          <Button onClick={handleSync} disabled={syncing} variant="outline">
            <RefreshCw size={14} className={syncing ? "animate-spin mr-2" : "mr-2"} />
            {syncing ? "Syncing..." : "Sync Now"}
          </Button>
          {syncResult && (
            <div className="flex items-center gap-2 rounded-lg bg-indigo-50 border border-indigo-200 p-3">
              <Zap size={16} className="text-indigo-500" />
              <span className="text-sm font-medium text-indigo-700">{syncResult}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stripe (Placeholder) */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50">
            <CreditCard size={16} className="text-violet-500" />
          </div>
          <div>
            <CardTitle className="text-base">Stripe</CardTitle>
            <p className="text-xs text-muted-foreground">Billing &amp; subscriptions</p>
          </div>
          <Badge variant="secondary" className="ml-auto bg-gray-100 text-gray-500 border border-gray-200 text-[10px]">Coming Soon</Badge>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/50 p-6 text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              Stripe integration for automated billing, invoicing, and payment tracking will be available soon.
            </p>
            <Button disabled variant="outline" className="text-xs">
              Connect Stripe Account
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
