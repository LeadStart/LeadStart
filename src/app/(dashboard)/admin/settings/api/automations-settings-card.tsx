"use client";

// Internal automations — org-level notify config (migration 00087). The
// delivery side of the Flow builder's kind:'internal' notify/webhook nodes:
// when a reply is classified, LeadStart pings the targets configured here
// (Slack incoming webhook / generic outbound webhook / a teammate email).
//
// Reads a MASKED status from the API (secrets never leave the server), so the
// three secret-ish fields are write-only: an empty input keeps the saved value,
// typing a new one overwrites, and Remove clears it (ms-oauth card convention).

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Zap, CheckCircle, XCircle, Loader2, AlertTriangle, Send } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { AutomationNotifyOn, AutomationSettingsStatus } from "@/types/app";

type ChannelResult = {
  channel: "slack" | "webhook" | "email";
  ok: boolean;
  skippedReason?: string;
  error?: string;
};

export function AutomationsSettingsCard() {
  const [status, setStatus] = useState<AutomationSettingsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editable non-secret fields (mirrored from status on load).
  const [enabled, setEnabled] = useState(false);
  const [notifyOn, setNotifyOn] = useState<AutomationNotifyOn>("hot");
  const [notifyEmail, setNotifyEmail] = useState("");

  // Write-only secret inputs (start blank; blank = keep saved).
  const [slackUrl, setSlackUrl] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelResult[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const applyStatus = useCallback((s: AutomationSettingsStatus) => {
    setStatus(s);
    setEnabled(s.enabled);
    setNotifyOn(s.notify_on);
    setNotifyEmail(s.notify_email);
    // Clear the write-only inputs after every load/save.
    setSlackUrl("");
    setWebhookUrl("");
    setWebhookSecret("");
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(appUrl("/api/admin/automations/settings"), { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) {
        setLoadError(d.error ?? `Failed to load settings (${res.status})`);
        return;
      }
      applyStatus(d.status as AutomationSettingsStatus);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load settings");
    }
  }, [applyStatus]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(extra?: Record<string, unknown>) {
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    setTestResult(null);
    try {
      const settings: Record<string, unknown> = {
        enabled,
        notify_on: notifyOn,
        notify_email: notifyEmail.trim(),
        ...extra,
      };
      // Only send secret fields when the user actually typed one.
      if (slackUrl.trim()) settings.slack_webhook_url = slackUrl.trim();
      if (webhookUrl.trim()) settings.outbound_webhook_url = webhookUrl.trim();
      if (webhookSecret.trim()) settings.outbound_webhook_secret = webhookSecret.trim();

      const res = await fetch(appUrl("/api/admin/automations/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const d = await res.json();
      if (!res.ok) {
        setSaveError(d.error ?? `Save failed (${res.status})`);
        return;
      }
      applyStatus(d.status as AutomationSettingsStatus);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const res = await fetch(appUrl("/api/admin/automations/test"), { method: "POST" });
      const d = await res.json();
      if (!res.ok) {
        setTestError(d.error ?? `Test failed (${res.status})`);
        return;
      }
      setTestResult((d.result?.results ?? []) as ChannelResult[]);
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600">
          <Zap size={16} className="text-white" />
        </div>
        <div>
          <CardTitle className="text-base">Internal automations</CardTitle>
          <p className="text-xs text-muted-foreground">
            Ping your team when a lead replies — post to Slack, hit a webhook, or
            email a teammate. Fires from the reply pipeline.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
            <span>{loadError}</span>
          </div>
        ) : !status ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> Loading automation settings…
          </div>
        ) : (
          <>
            {/* master toggle */}
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border accent-[#7c3aed] cursor-pointer"
              />
              <span>
                Enable reply notifications
                <span className="block text-[11px] text-muted-foreground">
                  When off, no Slack / webhook / email pings fire — the reply still
                  classifies and the per-client hot-lead email is unaffected.
                </span>
              </span>
            </label>

            {/* trigger filter */}
            <div className="space-y-1">
              <Label className="text-sm font-medium">Notify on</Label>
              <Select value={notifyOn} onValueChange={(v) => v && setNotifyOn(v as AutomationNotifyOn)}>
                <SelectTrigger className="w-[280px]" disabled={!enabled}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hot">Positive replies only (interested, meeting, referral)</SelectItem>
                  <SelectItem value="all_replies">Every reply</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                &quot;Positive replies&quot; covers the hot classes — interested, meeting
                booked, qualifying question, referral. &quot;Every reply&quot; also pings
                on objections, out-of-office, not-interested, etc.
              </p>
            </div>

            {/* Slack */}
            <div className="space-y-1">
              <Label htmlFor="autoSlack" className="text-sm font-medium">
                Slack incoming webhook{" "}
                {status.slack_webhook_url_set ? (
                  <span className="text-emerald-600">(saved)</span>
                ) : null}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="autoSlack"
                  type="password"
                  value={slackUrl}
                  onChange={(e) => setSlackUrl(e.target.value)}
                  placeholder={
                    status.slack_webhook_url_set
                      ? "•••••••• (leave blank to keep)"
                      : "https://hooks.slack.com/services/…"
                  }
                  className="max-w-[420px]"
                />
                {status.slack_webhook_url_set && (
                  <button
                    type="button"
                    onClick={() => save({ clear_slack: true })}
                    className="text-xs text-red-600 hover:underline cursor-pointer"
                  >
                    Remove
                  </button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Create one at Slack &rarr; Apps &rarr; Incoming Webhooks; paste the
                channel&apos;s URL here.
              </p>
            </div>

            {/* teammate email */}
            <div className="space-y-1">
              <Label htmlFor="autoEmail" className="text-sm font-medium">
                Notify a teammate (email)
              </Label>
              <Input
                id="autoEmail"
                type="email"
                value={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.value)}
                placeholder="teammate@yourcompany.com"
                className="max-w-[420px]"
              />
              <p className="text-[11px] text-muted-foreground">
                An extra address emailed on each event, separate from the per-client
                hot-lead notification. Leave blank for none.
              </p>
            </div>

            {/* generic outbound webhook */}
            <div className="space-y-1">
              <Label htmlFor="autoWebhook" className="text-sm font-medium">
                Outbound webhook URL{" "}
                {status.outbound_webhook_url_set ? (
                  <span className="text-emerald-600">
                    (saved{status.outbound_webhook_url_host ? ` · ${status.outbound_webhook_url_host}` : ""})
                  </span>
                ) : null}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="autoWebhook"
                  type="password"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder={
                    status.outbound_webhook_url_set
                      ? "•••••••• (leave blank to keep)"
                      : "https://your-app.com/hooks/leadstart"
                  }
                  className="max-w-[420px]"
                />
                {status.outbound_webhook_url_set && (
                  <button
                    type="button"
                    onClick={() => save({ clear_outbound_webhook: true })}
                    className="text-xs text-red-600 hover:underline cursor-pointer"
                  >
                    Remove
                  </button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                We POST a JSON event here. Set a signing secret below to receive an{" "}
                <code>X-LeadStart-Signature: sha256=…</code> header over the raw body.
              </p>
            </div>

            {/* webhook secret */}
            <div className="space-y-1">
              <Label htmlFor="autoSecret" className="text-sm font-medium">
                Webhook signing secret{" "}
                {status.outbound_webhook_secret_set ? (
                  <span className="text-emerald-600">(saved)</span>
                ) : null}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="autoSecret"
                  type="password"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  placeholder={
                    status.outbound_webhook_secret_set
                      ? "•••••••• (leave blank to keep)"
                      : "optional shared secret"
                  }
                  className="max-w-[420px]"
                />
                {status.outbound_webhook_secret_set && (
                  <button
                    type="button"
                    onClick={() => save({ clear_outbound_secret: true })}
                    className="text-xs text-red-600 hover:underline cursor-pointer"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 items-center pt-1">
              <Button onClick={() => save()} disabled={saving} style={{ background: "#7c3aed" }}>
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button
                variant="outline"
                onClick={sendTest}
                disabled={testing || saving}
                className="gap-1.5"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                Send test
              </Button>
              {saved && (
                <span className="text-sm text-emerald-600 flex items-center gap-1">
                  <CheckCircle size={14} /> Saved
                </span>
              )}
            </div>

            {saveError && (
              <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                <XCircle size={16} className="text-red-500" />
                <span className="text-sm font-medium text-red-700">Save failed: {saveError}</span>
              </div>
            )}
            {testError && (
              <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                <XCircle size={16} className="text-red-500" />
                <span className="text-sm font-medium text-red-700">{testError}</span>
              </div>
            )}
            {testResult && (
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Test delivery</p>
                {testResult.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No targets attempted.</p>
                ) : (
                  testResult.map((r) => (
                    <div key={r.channel} className="flex items-center gap-2 text-sm">
                      {r.ok ? (
                        <CheckCircle size={14} className="text-emerald-600" />
                      ) : (
                        <XCircle size={14} className="text-red-500" />
                      )}
                      <span className="capitalize font-medium">{r.channel}</span>
                      <span className="text-muted-foreground">
                        {r.ok ? "delivered" : r.skippedReason ?? r.error ?? "failed"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
