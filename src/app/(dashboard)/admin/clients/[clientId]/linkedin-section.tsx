"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronRight,
  Link2,
  Unlink,
  RefreshCw,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { Client } from "@/types/app";

// Lucide's brand-icon set was removed upstream, so inline the LinkedIn
// glyph (matches the same SVG used in the org-level Unipile settings card).
function LinkedinIcon({
  size = 16,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
    </svg>
  );
}

type Status = "disconnected" | "connected" | "expired";

function statusOf(client: Client): Status {
  return (client.unipile_account_status as Status | null | undefined) ??
    "disconnected";
}

function StatusPill({ status }: { status: Status }) {
  const cfg = {
    connected: {
      label: "Connected",
      cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
    },
    expired: {
      label: "Expired",
      cls: "bg-amber-50 text-amber-700 border-amber-200",
    },
    disconnected: {
      label: "Disconnected",
      cls: "bg-gray-100 text-gray-600 border-gray-200",
    },
  }[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

export function LinkedinSection({
  client,
  onChanged,
}: {
  client: Client;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = statusOf(client);
  const accountId = client.unipile_account_id ?? null;

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        appUrl(`/api/admin/clients/${client.id}/linkedin/connect-start`),
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        throw new Error(data.error || `Connect failed (${res.status})`);
      }
      window.location.href = data.url as string;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (
      !window.confirm(
        "Disconnect this LinkedIn account? You'll need to re-authorize to send or receive on LinkedIn.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        appUrl(`/api/admin/clients/${client.id}/linkedin/disconnect`),
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Disconnect failed (${res.status})`);
      }
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader
        className="flex flex-row items-center gap-2 pb-3 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0A66C2]">
          <LinkedinIcon size={16} className="text-white" />
        </div>
        <CardTitle className="text-base flex-1">LinkedIn channel</CardTitle>
        <StatusPill status={status} />
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          {status === "connected" && accountId && (
            <>
              <p className="text-sm text-muted-foreground">
                Connected via Unipile. Outbound invitations and messages will
                originate from this LinkedIn account; inbound replies arrive
                on the next webhook event.
              </p>
              <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs">
                <span className="text-muted-foreground">Account ID&nbsp;</span>
                <span className="font-mono break-all">{accountId}</span>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  onClick={handleDisconnect}
                  disabled={busy}
                  className="gap-1.5"
                >
                  <Unlink size={14} />
                  {busy ? "Working…" : "Disconnect"}
                </Button>
              </div>
            </>
          )}
          {status === "expired" && (
            <>
              <p className="text-sm text-muted-foreground">
                LinkedIn forced a re-authorization (cookies expire every 1–3
                months). Reconnect to resume sending and receiving.
              </p>
              <div className="flex items-center gap-3">
                <Button
                  onClick={handleConnect}
                  disabled={busy}
                  className="gap-1.5 text-white"
                  style={{ background: "#0A66C2" }}
                >
                  <RefreshCw size={14} />
                  {busy ? "Opening…" : "Reconnect"}
                </Button>
              </div>
            </>
          )}
          {status === "disconnected" && (
            <>
              <p className="text-sm text-muted-foreground">
                Connect this client&apos;s LinkedIn account through Unipile&apos;s
                hosted auth flow. Sign in with the client&apos;s LinkedIn
                credentials when prompted; you&apos;ll land back here once
                authorized.
              </p>
              <div className="flex items-center gap-3">
                <Button
                  onClick={handleConnect}
                  disabled={busy}
                  className="gap-1.5 text-white"
                  style={{ background: "#0A66C2" }}
                >
                  <Link2 size={14} />
                  {busy ? "Opening…" : "Connect LinkedIn"}
                </Button>
              </div>
            </>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
          <p className="text-[11px] text-muted-foreground border-t border-border/30 pt-3">
            LinkedIn account access is brokered through Unipile. Re-auth
            required when LinkedIn cookies expire (typically every 1–3 months).
          </p>
        </CardContent>
      )}
    </Card>
  );
}
