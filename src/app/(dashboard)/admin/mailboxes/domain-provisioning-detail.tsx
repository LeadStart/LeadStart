"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, KeyRound, RefreshCw } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type {
  ProvisioningState,
  ProvisioningStepId,
  SendingDomain,
} from "@/types/app";

const STEP_LABEL: Record<ProvisioningStepId, string> = {
  dns_records: "DNS records",
  workspace_domain: "Add domain to Workspace",
  site_verification_token: "Get verification token",
  site_verification: "Verify domain ownership",
  users: "Create inboxes",
  licenses: "Assign licenses",
  mailboxes: "Register mailboxes",
  dkim: "DKIM authentication",
};
const STEP_ORDER: ProvisioningStepId[] = [
  "dns_records",
  "workspace_domain",
  "site_verification_token",
  "site_verification",
  "users",
  "licenses",
  "mailboxes",
  "dkim",
];

function dotClass(status: string): string {
  switch (status) {
    case "done":
      return "bg-emerald-500";
    case "skipped":
      return "bg-slate-300";
    case "in_progress":
      return "bg-amber-500 animate-pulse";
    case "failed":
      return "bg-red-500";
    default:
      return "bg-slate-200";
  }
}

interface DnsData {
  expected: { type: string; name: string; content: string }[];
  registrar_records: { type: string; name: string; content: string }[] | null;
  registrar_error: string | null;
  live: {
    auth: { spf: { status: string }; dkim: { status: string }; dmarc: { status: string } } | null;
    mx: { status: string } | null;
  };
}

export function DomainProvisioningDetail({
  domain,
  onChange,
}: {
  domain: SendingDomain;
  onChange: () => void;
}) {
  const prov = domain.provisioning as ProvisioningState | null;
  const [busy, setBusy] = useState<string | null>(null);
  const [passwords, setPasswords] = useState<{ email: string; password: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [dns, setDns] = useState<DnsData | null>(null);
  const [dkimValue, setDkimValue] = useState("");

  const loadDns = useCallback(async () => {
    try {
      const res = await fetch(appUrl(`/api/admin/domains/${domain.id}/dns`));
      if (res.ok) setDns((await res.json()) as DnsData);
    } catch {
      /* best-effort */
    }
  }, [domain.id]);

  useEffect(() => {
    loadDns();
  }, [loadDns]);

  async function post(path: string, body?: unknown, label?: string) {
    setBusy(label ?? path);
    setNote(null);
    try {
      const res = await fetch(appUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        setNote(data.error ?? "Something went wrong.");
        return null;
      }
      if (Array.isArray(data.revealed_passwords) && data.revealed_passwords.length) {
        setPasswords((p) => [...p, ...data.revealed_passwords]);
      }
      onChange();
      loadDns();
      return data;
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 rounded-lg bg-muted/30 p-3 text-sm">
      {note && <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{note}</div>}

      {/* One-time password reveal */}
      {passwords.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-amber-900">
            <KeyRound size={13} /> Inbox passwords — shown once, not stored
          </div>
          <ul className="space-y-0.5 font-mono text-amber-900">
            {passwords.map((p) => (
              <li key={p.email}>
                {p.email}: <span className="select-all">{p.password}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-amber-700">
            Sending uses the service account (domain-wide delegation), so you don&rsquo;t need these to
            send. Reset in Google Admin if you ever need console login.
          </p>
        </div>
      )}

      {/* provisioning + not started → inbox setup form; started → stepper;
          any other status (e.g. active) → neither, just the DNS panel below */}
      {!prov && domain.lifecycle_status === "provisioning" ? (
        <p className="text-xs text-muted-foreground">
          Not set up yet. Use <span className="font-medium text-foreground">Set up inboxes</span> on this
          domain&rsquo;s row to pick a Workspace and name the inboxes.
        </p>
      ) : prov ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Provisioning progress</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => post(`/api/admin/domains/${domain.id}/provisioning/advance`, undefined, "check")}
              disabled={busy === "check"}
            >
              {busy === "check" ? <Loader2 size={13} className="animate-spin" /> : <><RefreshCw size={12} /> Check now</>}
            </Button>
          </div>
          <ul className="space-y-1">
            {STEP_ORDER.map((id) => {
              const st = prov.steps[id];
              return (
                <li key={id} className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${dotClass(st.status)}`} />
                  <span className="text-xs">{STEP_LABEL[id]}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">{st.status}</span>
                  {st.last_error && st.status !== "done" && (
                    <span className="truncate text-[10px] text-red-600" title={st.last_error}>
                      {st.last_error}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* DKIM paste — only while provisioning (active domains already have it) */}
      {domain.lifecycle_status === "provisioning" && (
      <div className="space-y-1 border-t border-border/50 pt-3">
        <Label className="text-xs">DKIM authentication</Label>
        <p className="text-[11px] text-muted-foreground">
          Generate DKIM in Google Admin &rarr; Apps &rarr; Google Workspace &rarr; Gmail &rarr; Authenticate email,
          then paste the record value here. Detection is automatic once it&rsquo;s live.
        </p>
        <div className="flex items-end gap-2">
          <Input
            placeholder="v=DKIM1; k=rsa; p=…"
            value={dkimValue}
            onChange={(e) => setDkimValue(e.target.value)}
            className="flex-1 font-mono text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (!dkimValue.trim()) return;
              const r = await post(`/api/admin/domains/${domain.id}/dkim`, { value: dkimValue.trim() }, "dkim");
              if (r) setDkimValue("");
            }}
            disabled={busy === "dkim" || !dkimValue.trim()}
          >
            {busy === "dkim" ? <Loader2 size={13} className="animate-spin" /> : "Write DKIM"}
          </Button>
        </div>
      </div>
      )}

      {/* DNS panel */}
      <div className="space-y-1 border-t border-border/50 pt-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs">DNS records</Label>
          {domain.registrar !== "manual" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => post(`/api/admin/domains/${domain.id}/dns/apply`, undefined, "retrydns")}
              disabled={busy === "retrydns"}
            >
              {busy === "retrydns" ? <Loader2 size={13} className="animate-spin" /> : "Retry DNS"}
            </Button>
          )}
        </div>
        {dns?.live.auth && (
          <div className="flex gap-3 text-[11px]">
            <span>SPF: <b>{dns.live.auth.spf.status}</b></span>
            <span>DKIM: <b>{dns.live.auth.dkim.status}</b></span>
            <span>DMARC: <b>{dns.live.auth.dmarc.status}</b></span>
            <span>MX: <b>{dns.live.mx?.status ?? "—"}</b></span>
          </div>
        )}
        {dns && (
          <div className="mt-1 max-h-40 overflow-auto rounded border border-border/50 bg-background p-2">
            <table className="w-full text-[11px]">
              <tbody>
                {dns.expected.map((r, i) => (
                  <tr key={i} className="align-top">
                    <td className="pr-2 font-mono text-muted-foreground">{r.type}</td>
                    <td className="pr-2 font-mono">{r.name || "@"}</td>
                    <td className="break-all font-mono">{r.content}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {domain.registrar === "manual" && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                Manual registrar — add these records at your DNS host by hand.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
