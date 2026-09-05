"use client";

// Microsoft OAuth app (seed inboxes): the Entra app registration used to
// connect Outlook.com / Microsoft 365 seed inboxes for placement testing
// (migration 00085). Two fields: client id + secret. The secret is never read
// back into the browser (the route returns only has_* booleans), so the inputs
// start blank; typing replaces the stored value, blank keeps it. No test
// button: the Connect Microsoft seed button on the Mailboxes page validates
// the credentials by actually running the OAuth flow.

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, CheckCircle } from "lucide-react";
import { appUrl } from "@/lib/api-url";

type Status = { has_client_id: boolean; has_secret: boolean };

export function MsOauthSettingsCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/api/admin/ms-oauth/settings"), { cache: "no-store" });
      const d = await res.json();
      if (res.ok) setStatus(d as Status);
    } catch {
      /* non-fatal: the card still lets you save */
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // Show the exact redirect URI to register in Entra (this app's own origin).
    if (typeof window !== "undefined") {
      setRedirectUri(`${window.location.origin}/app/api/admin/seed-inboxes/oauth/microsoft/callback`);
    }
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    const body: Record<string, string> = {};
    if (clientId.trim()) body.ms_oauth_client_id = clientId.trim();
    if (secret.trim()) body.ms_oauth_client_secret = secret.trim();
    if (Object.keys(body).length === 0) {
      setError("Enter a client ID or secret to save.");
      setSaving(false);
      return;
    }
    try {
      const res = await fetch(appUrl("/api/admin/ms-oauth/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (res.ok) {
        setStatus(d as Status);
        setClientId("");
        setSecret("");
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      } else {
        setError(d.error ?? "Save failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const configured = status?.has_client_id && status?.has_secret;

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-600">
          <KeyRound size={16} className="text-white" />
        </div>
        <div>
          <CardTitle className="text-base">Microsoft OAuth app (seed inboxes)</CardTitle>
          <p className="text-xs text-muted-foreground">
            Lets you connect Outlook.com / Microsoft 365 inboxes as placement seeds. Register a
            multi-tenant Entra app (personal Microsoft accounts allowed), then paste its client ID
            and a client secret here.
            {configured ? (
              <span className="ml-1 inline-flex items-center gap-1 text-emerald-600">
                <CheckCircle size={12} /> configured
              </span>
            ) : null}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-border bg-slate-50 px-3 py-2 text-[11px] text-muted-foreground">
          Redirect URI to register in the Entra app (Web platform):
          <code className="mt-1 block break-all text-slate-700">
            {redirectUri || "…/app/api/admin/seed-inboxes/oauth/microsoft/callback"}
          </code>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="msClientId" className="text-sm font-medium">
              Client ID {status?.has_client_id ? <span className="text-emerald-600">(saved)</span> : null}
            </Label>
            <Input
              id="msClientId"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="msSecret" className="text-sm font-medium">
              Client secret {status?.has_secret ? <span className="text-emerald-600">(saved)</span> : null}
            </Label>
            <Input
              id="msSecret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={status?.has_secret ? "•••••••• (leave blank to keep)" : "Entra client secret"}
            />
          </div>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={saving} style={{ background: "#2E37FE" }}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {saved && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
              <CheckCircle size={14} /> Saved
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Client secrets expire (max 24 months). When one lapses, Microsoft seeds stop reading and
          show a Reconnect prompt: save a fresh secret here, then reconnect.
        </p>
      </CardContent>
    </Card>
  );
}
