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
import { appUrl } from "@/lib/api-url";

// Generate hour options 1-12 for AM/PM display
const HOUR_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: String(i === 0 ? 12 : i),
  label: String(i === 0 ? 12 : i),
}));

const AMPM_OPTIONS = [
  { value: "AM", label: "AM" },
  { value: "PM", label: "PM" },
];

// Convert 24h to 12h + AM/PM
function to12h(hour24: string): { hour: string; ampm: string } {
  const h = parseInt(hour24);
  if (h === 0) return { hour: "12", ampm: "AM" };
  if (h === 12) return { hour: "12", ampm: "PM" };
  if (h > 12) return { hour: String(h - 12), ampm: "PM" };
  return { hour: String(h), ampm: "AM" };
}

// Convert 12h + AM/PM to 24h
function to24h(hour12: string, ampm: string): string {
  let h = parseInt(hour12);
  if (ampm === "AM" && h === 12) h = 0;
  else if (ampm === "PM" && h !== 12) h += 12;
  return String(h);
}

export default function IntegrationsPage() {
  const { organizationId } = useUser();
  const [org, setOrg] = useState<Organization | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [resendKey, setResendKey] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  const [syncHour12, setSyncHour12] = useState("6");
  const [syncAmPm, setSyncAmPm] = useState("AM");
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
            resend_api_key?: string;
            email_from?: string;
          };
          setOrg(typedOrg);
          setApiKey(typedOrg.instantly_api_key || "");
          if (typedOrg.sync_hour) {
            const { hour, ampm } = to12h(typedOrg.sync_hour);
            setSyncHour12(hour);
            setSyncAmPm(ampm);
          }
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
      const res = await fetch(appUrl("/api/instantly/test"), {
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
      const res = await fetch(appUrl("/api/cron/sync-analytics"), { method: "POST" });
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

    const syncHour24 = to24h(syncHour12, syncAmPm);
    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({ sync_hour: syncHour24 })
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
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Settings</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Integrations</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            Manage API connections, email, and sync schedules
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Instantly.ai API Key */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Key size={16} className="text-white" />
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
            <Button onClick={handleSaveApiKey} disabled={saving} style={{ background: '#2E37FE' }}>
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
            <Button onClick={handleSaveResend} disabled={savingResend} style={{ background: '#2E37FE' }}>
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
            <CardTitle className="text-base">Data Sync Schedule</CardTitle>
            <p className="text-xs text-muted-foreground">Control when campaign analytics are pulled from Instantly</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw size={14} className="text-muted-foreground" />
            <p className="text-sm font-medium">Daily Analytics Sync</p>
            <Badge variant="secondary" className="badge-green text-[10px]">Active</Badge>
          </div>

          <div className="space-y-1">
            <Label className="text-sm font-medium">Sync Time</Label>
            <div className="flex items-center gap-2">
              <Select value={syncHour12} onValueChange={(v) => v && setSyncHour12(v)}>
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOUR_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground text-sm">:</span>
              <span className="text-sm font-medium w-8">00</span>
              <Select value={syncAmPm} onValueChange={(v) => v && setSyncAmPm(v)}>
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AMPM_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Badge variant="secondary" className="badge-blue text-[10px] ml-2">
                Eastern Time (ET)
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">Pulls latest campaign data from Instantly.ai for all active campaigns</p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button onClick={handleSaveSchedule} disabled={savingSchedule} style={{ background: '#2E37FE' }}>
              {savingSchedule ? "Saving..." : "Save Schedule"}
            </Button>
            {scheduleSaved && (
              <span className="text-sm text-emerald-600 flex items-center gap-1">
                <CheckCircle size={14} /> Saved
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Manual Sync */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Zap size={16} className="text-white" />
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
            <div className="flex items-center gap-2 rounded-lg bg-[#2E37FE]/10 border border-[#2E37FE]/20 p-3">
              <Zap size={16} className="text-[#2E37FE]" />
              <span className="text-sm font-medium text-[#6B72FF]">{syncResult}</span>
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
          <div className="rounded-xl border border-dashed border-gray-200 bg-background/50 p-6 text-center space-y-2">
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
