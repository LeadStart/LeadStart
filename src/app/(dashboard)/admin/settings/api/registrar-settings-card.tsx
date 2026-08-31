"use client";

// Domain registrars (Phase 2) — Porkbun + Spaceship API credentials and the
// hard monthly spend cap for automated domain purchases. Secrets are never
// returned by the API (only has_porkbun/has_spaceship + the cap), so the inputs
// start blank; typing a value replaces the stored one, leaving it blank keeps it.

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Globe, Loader2, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { appUrl } from "@/lib/api-url";

type Status = {
  has_porkbun: boolean;
  has_spaceship: boolean;
  // Per-field presence, so we can flag a half-saved provider (key without secret).
  porkbun_key?: boolean;
  porkbun_secret?: boolean;
  spaceship_key?: boolean;
  spaceship_secret?: boolean;
  spend_cap_usd: number | null;
};
type TestState = { ok: boolean; msg: string } | null;

export function RegistrarSettingsCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; msg: string } | null>(null);

  const [pkKey, setPkKey] = useState("");
  const [pkSecret, setPkSecret] = useState("");
  const [ssKey, setSsKey] = useState("");
  const [ssSecret, setSsSecret] = useState("");
  const [cap, setCap] = useState("");

  const [testing, setTesting] = useState<string | null>(null);
  const [testPk, setTestPk] = useState<TestState>(null);
  const [testSs, setTestSs] = useState<TestState>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/api/admin/registrar/settings"), { cache: "no-store" });
      const d = await res.json();
      if (res.ok) {
        setStatus(d as Status);
        setCap(d.spend_cap_usd != null ? String(d.spend_cap_usd) : "");
      } else {
        setBanner({ kind: "error", msg: d.error ?? "Failed to load registrar settings" });
      }
    } catch (e) {
      setBanner({ kind: "error", msg: e instanceof Error ? e.message : "Failed to load" });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    setBanner(null);
    const body: Record<string, unknown> = {};
    if (pkKey.trim()) body.porkbun_api_key = pkKey.trim();
    if (pkSecret.trim()) body.porkbun_api_secret = pkSecret.trim();
    if (ssKey.trim()) body.spaceship_api_key = ssKey.trim();
    if (ssSecret.trim()) body.spaceship_api_secret = ssSecret.trim();
    body.spend_cap_usd = cap.trim() === "" ? null : Number(cap);
    try {
      const res = await fetch(appUrl("/api/admin/registrar/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (res.ok) {
        setStatus(d as Status);
        setPkKey("");
        setPkSecret("");
        setSsKey("");
        setSsSecret("");
        setBanner({ kind: "success", msg: "Saved." });
      } else {
        setBanner({ kind: "error", msg: d.error ?? "Save failed" });
      }
    } catch (e) {
      setBanner({ kind: "error", msg: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  async function runTest(provider: "porkbun" | "spaceship") {
    setTesting(provider);
    const setT = provider === "porkbun" ? setTestPk : setTestSs;
    setT(null);
    try {
      const res = await fetch(appUrl("/api/admin/registrar/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const d = await res.json();
      setT({ ok: !!d.ok, msg: d.ok ? d.detail : d.error ?? "Test failed" });
    } catch (e) {
      setT({ ok: false, msg: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(null);
    }
  }

  const configuredBadge = (on: boolean) =>
    on ? (
      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
        Configured
      </span>
    ) : (
      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-500">
        Not set
      </span>
    );

  const testLine = (t: TestState) =>
    t && (
      <p className={`flex items-center gap-1.5 text-[11px] ${t.ok ? "text-emerald-600" : "text-red-600"}`}>
        {t.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
        {t.msg}
      </p>
    );

  // Both a key AND a secret are required. Flag a half-saved provider so a save
  // that only took the key doesn't read as fully configured.
  const partialHint = (keySet?: boolean, secretSet?: boolean) =>
    keySet && !secretSet ? (
      <p className="flex items-center gap-1.5 text-[11px] text-amber-600">
        <AlertTriangle size={12} /> API key saved, but the <b>secret key</b> is missing — enter it and Save.
      </p>
    ) : !keySet && secretSet ? (
      <p className="flex items-center gap-1.5 text-[11px] text-amber-600">
        <AlertTriangle size={12} /> Secret key saved, but the <b>API key</b> is missing — enter it and Save.
      </p>
    ) : null;

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
          <Globe size={16} className="text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <CardTitle className="text-base">Domain registrars</CardTitle>
          <p className="text-xs text-muted-foreground">
            Porkbun &amp; Spaceship API keys for automatically buying sending domains and writing their
            DNS. A domain is bought from whichever registrar is cheaper. Purchases never exceed the
            monthly cap below, and nothing buys until both a key and a cap are set.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {banner && (
          <div
            className={
              banner.kind === "success"
                ? "flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-sm text-emerald-700"
                : "flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-700"
            }
          >
            {banner.kind === "success" ? <CheckCircle size={15} /> : <XCircle size={15} />}
            {banner.msg}
          </div>
        )}

        {/* Porkbun */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label className="text-sm font-semibold">Porkbun</Label>
            {status && configuredBadge(status.has_porkbun)}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              type="password"
              value={pkKey}
              onChange={(e) => setPkKey(e.target.value)}
              placeholder={status?.has_porkbun ? "API key (saved — enter to replace)" : "API key"}
            />
            <Input
              type="password"
              value={pkSecret}
              onChange={(e) => setPkSecret(e.target.value)}
              placeholder={status?.has_porkbun ? "Secret key (saved — enter to replace)" : "Secret key"}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => runTest("porkbun")}
              disabled={testing === "porkbun" || !status?.has_porkbun}
              className="gap-1.5"
            >
              {testing === "porkbun" ? <Loader2 size={13} className="animate-spin" /> : null}
              Test connection
            </Button>
            {testLine(testPk)}
          </div>
          {status && partialHint(status.porkbun_key, status.porkbun_secret)}
          <p className="text-[11px] text-muted-foreground">
            Supports API URL forwarding — a sending domain can 301-redirect to the client&rsquo;s site
            automatically (set it per-domain under Mailboxes).
          </p>
        </div>

        {/* Spaceship */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label className="text-sm font-semibold">Spaceship</Label>
            {status && configuredBadge(status.has_spaceship)}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              type="password"
              value={ssKey}
              onChange={(e) => setSsKey(e.target.value)}
              placeholder={status?.has_spaceship ? "API key (saved — enter to replace)" : "API key"}
            />
            <Input
              type="password"
              value={ssSecret}
              onChange={(e) => setSsSecret(e.target.value)}
              placeholder={status?.has_spaceship ? "API secret (saved — enter to replace)" : "API secret"}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => runTest("spaceship")}
              disabled={testing === "spaceship" || !status?.has_spaceship}
              className="gap-1.5"
            >
              {testing === "spaceship" ? <Loader2 size={13} className="animate-spin" /> : null}
              Test connection
            </Button>
            {testLine(testSs)}
          </div>
          {status && partialHint(status.spaceship_key, status.spaceship_secret)}
          <p className="text-[11px] text-muted-foreground">
            No forwarding API — set domain redirects manually in the Spaceship dashboard when needed.
          </p>
        </div>

        {/* Spend cap */}
        <div className="space-y-1.5">
          <Label htmlFor="registrar-cap" className="text-sm font-semibold">
            Monthly spend cap (USD)
          </Label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              id="registrar-cap"
              type="number"
              min="0"
              step="1"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="25"
              className="max-w-[140px]"
            />
            <span className="text-xs text-muted-foreground">
              per month — hard ceiling, fail-closed. Blank = purchasing disabled.
            </span>
          </div>
        </div>

        <Button onClick={save} disabled={saving} className="gap-1.5">
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          Save registrar settings
        </Button>
      </CardContent>
    </Card>
  );
}
