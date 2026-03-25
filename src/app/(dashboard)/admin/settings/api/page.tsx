"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useUser } from "@/hooks/use-user";
import { Key, RefreshCw, CheckCircle, XCircle, Zap } from "lucide-react";
import type { Organization } from "@/types/app";

export default function APISettingsPage() {
  const { organizationId } = useUser();
  const [org, setOrg] = useState<Organization | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "fail" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

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
          const typedOrg = data as Organization;
          setOrg(typedOrg);
          setApiKey(typedOrg.instantly_api_key || "");
        }
      });
  }, [organizationId]);

  async function handleSave() {
    if (!organizationId) return;
    setSaving(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase
      .from("organizations")
      .update({ instantly_api_key: apiKey })
      .eq("id", organizationId);

    if (error) {
      setError(error.message);
    }
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Settings</p>
          <h1 className="text-2xl font-bold mt-1">API Settings</h1>
          <p className="text-sm text-white/60 mt-1">
            Manage your Instantly.ai integration
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <Key size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Instantly.ai API Key</CardTitle>
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
            <Button onClick={handleSave} disabled={saving} style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
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

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <RefreshCw size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Data Sync</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Manually trigger a sync of campaign analytics from Instantly.ai. This pulls the latest data for all active campaigns.
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
    </div>
  );
}
