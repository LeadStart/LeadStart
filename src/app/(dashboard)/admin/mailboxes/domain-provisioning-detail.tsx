"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, KeyRound, RefreshCw, AlertTriangle } from "lucide-react";
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

// Coarse "x min ago" for the current-step banner, so it's obvious the flow is
// alive and re-checking (vs. genuinely frozen).
function relTime(iso?: string): string {
  if (!iso) return "just now";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "moments ago";
  if (min === 1) return "1 min ago";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  return hr === 1 ? "1 hr ago" : `${hr} hr ago`;
}

const ACTIVE_BADGE: Record<string, string> = {
  in_progress: "Working",
  failed: "Needs attention",
  pending: "Queued",
};

interface DnsData {
  expected: { type: string; name: string; content: string }[];
  registrar_records: { type: string; name: string; content: string }[] | null;
  registrar_error: string | null;
  live: {
    auth: { spf: { status: string }; dkim: { status: string }; dmarc: { status: string } } | null;
    mx: { status: string } | null;
  };
}

interface ForwardEntry {
  subdomain: string;
  location: string;
  type: string;
  includePath: boolean;
  wildcard: boolean;
  providerId?: string;
}
interface ForwardStatus {
  registrar: string;
  supported: boolean;
  manual?: boolean;
  configured?: boolean;
  instructions?: string;
  error?: string;
  forwards?: ForwardEntry[];
  destination?: string;
}

export function DomainProvisioningDetail({
  domain,
  onChange,
}: {
  domain: SendingDomain;
  onChange: () => void;
}) {
  const prov = domain.provisioning as ProvisioningState | null;
  // The step the flow is currently on (first not-done/skipped) — drives the
  // prominent status banner so it's never a mystery what's happening.
  const activeStepId = prov
    ? STEP_ORDER.find((id) => prov.steps[id].status !== "done" && prov.steps[id].status !== "skipped")
    : undefined;
  const activeStep = prov && activeStepId ? prov.steps[activeStepId] : null;
  const [busy, setBusy] = useState<string | null>(null);
  const [passwords, setPasswords] = useState<{ email: string; password: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [dns, setDns] = useState<DnsData | null>(null);
  const [dkimValue, setDkimValue] = useState("");
  const [fwd, setFwd] = useState<ForwardStatus | null>(null);
  const [dest, setDest] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadDns = useCallback(async () => {
    try {
      const res = await fetch(appUrl(`/api/admin/domains/${domain.id}/dns`));
      if (res.ok) setDns((await res.json()) as DnsData);
    } catch {
      /* best-effort */
    }
  }, [domain.id]);

  const loadForwarding = useCallback(async () => {
    try {
      const res = await fetch(
        appUrl(`/api/admin/registrar/forward?domain=${encodeURIComponent(domain.domain)}`),
      );
      setFwd(res.ok ? ((await res.json()) as ForwardStatus) : null);
    } catch {
      /* best-effort */
    }
  }, [domain.domain]);

  useEffect(() => {
    loadDns();
    loadForwarding();
  }, [loadDns, loadForwarding]);

  // Auto-advance while this domain is actively provisioning, so the panel shows
  // live progress instead of waiting on the 10-min cron. Quiet (no spinner);
  // stops when the domain leaves provisioning or the active step fails (which
  // needs owner action). A latest-callback ref keeps the interval stable.
  const pollCbRef = useRef<() => void>(() => {});
  useEffect(() => {
    pollCbRef.current = () => {
      onChange();
      loadDns();
    };
  }, [onChange, loadDns]);
  const autoPolling =
    domain.lifecycle_status === "provisioning" && !!activeStepId && activeStep?.status !== "failed";
  useEffect(() => {
    if (!autoPolling) return;
    let cancelled = false;
    let running = false;
    const tick = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        const res = await fetch(appUrl(`/api/admin/domains/${domain.id}/provisioning/advance`), {
          method: "POST",
        });
        if (res.ok && !cancelled) {
          const data = await res.json();
          if (!cancelled) {
            if (Array.isArray(data.revealed_passwords) && data.revealed_passwords.length) {
              setPasswords((p) => [...p, ...data.revealed_passwords]);
            }
            pollCbRef.current();
          }
        }
      } catch {
        /* quiet — the cron and manual Check now are the fallback */
      } finally {
        running = false;
      }
    };
    const iv = setInterval(tick, 25000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [autoPolling, domain.id]);

  async function deleteDomain() {
    setBusy("delete");
    setNote(null);
    try {
      const res = await fetch(appUrl(`/api/admin/domains/${domain.id}`), { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote(data.error ?? "Could not delete the domain.");
        return;
      }
      onChange(); // refresh the list — this domain drops out
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  }

  async function setForwarding() {
    if (!dest.trim()) return;
    setBusy("forward");
    setNote(null);
    try {
      const res = await fetch(appUrl(`/api/admin/registrar/forward`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: domain.domain, destinationUrl: dest.trim() }),
      });
      const data = (await res.json()) as ForwardStatus & { error?: string };
      if (!res.ok) {
        setNote(data.error ?? "Something went wrong.");
        return;
      }
      setFwd({ ...data, forwards: data.forwards ?? [] });
      if (data.supported) setDest("");
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

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
              title="Re-check Google's side and move the setup forward one step now. Setup also re-checks on its own every ~25s while this is open."
              onClick={() => post(`/api/admin/domains/${domain.id}/provisioning/advance`, undefined, "check")}
              disabled={busy === "check"}
            >
              {busy === "check" ? <Loader2 size={13} className="animate-spin" /> : <><RefreshCw size={12} /> Check now</>}
            </Button>
          </div>
          {activeStep && activeStepId && (
            <div
              className={`rounded-lg border p-2.5 text-xs ${
                activeStep.status === "failed"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              }`}
            >
              <div className="flex items-center gap-1.5 font-semibold">
                {activeStep.status === "failed" ? (
                  <AlertTriangle size={13} className="flex-none" />
                ) : (
                  <Loader2 size={13} className="flex-none animate-spin" />
                )}
                <span>{STEP_LABEL[activeStepId]}</span>
                <span className="rounded-full bg-white/60 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide">
                  {ACTIVE_BADGE[activeStep.status] ?? activeStep.status}
                </span>
              </div>
              {activeStep.last_error && <p className="mt-1 leading-snug">{activeStep.last_error}</p>}
              <p className="mt-1 text-[10px] opacity-70">
                Checked {activeStep.attempts}× · last {relTime(activeStep.updated_at)}
                {activeStep.status !== "failed" && " · re-checks automatically"}
              </p>
            </div>
          )}
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
              title={`Re-write these records (Google MX, SPF, DMARC, verification) to your registrar (${domain.registrar}). Use this only if the DNS write failed or the records were changed — it is not needed while setup is just waiting on Google.`}
              onClick={() => post(`/api/admin/domains/${domain.id}/dns/apply`, undefined, "retrydns")}
              disabled={busy === "retrydns"}
            >
              {busy === "retrydns" ? <Loader2 size={13} className="animate-spin" /> : "Rewrite DNS"}
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

      {/* URL forwarding — redirect the bare domain to the client's real site.
          Porkbun sets this over its API; Spaceship/manual show the manual step. */}
      <div className="space-y-1 border-t border-border/50 pt-3">
        <Label className="text-xs">URL forwarding</Label>
        {!fwd ? (
          <p className="text-[11px] text-muted-foreground">Checking…</p>
        ) : fwd.supported ? (
          <>
            <p className="text-[11px] text-muted-foreground">
              301-redirect this domain (apex + www) to the client&rsquo;s real site so it never shows a
              dead parked page.
            </p>
            {(() => {
              const apex = fwd.forwards?.find((f) => !f.subdomain);
              return apex ? (
                <p className="text-[11px]">
                  Forwards to <b className="break-all">{apex.location}</b>
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">No forwarding set.</p>
              );
            })()}
            <div className="flex items-end gap-2">
              <Input
                placeholder="https://acme.com"
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                className="flex-1 text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={setForwarding}
                disabled={busy === "forward" || !dest.trim()}
              >
                {busy === "forward" ? <Loader2 size={13} className="animate-spin" /> : "Set forwarding"}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {fwd.instructions ?? fwd.error ?? "URL forwarding isn't available for this registrar via API."}
          </p>
        )}
      </div>

      {/* Delete / re-provision — removes the domain from Google Workspace + our
          tracking (registration + DNS untouched). Blocked if it has inboxes. */}
      <div className="border-t border-border/50 pt-3">
        {!confirmDelete ? (
          <button
            className="text-[11px] font-medium text-red-600 hover:underline"
            onClick={() => {
              setNote(null);
              setConfirmDelete(true);
            }}
          >
            Delete this domain
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-red-700">
              Remove <b>{domain.domain}</b> from Google Workspace and stop tracking it? Its registration
              and DNS records are left untouched, so you can set it up again from scratch.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={deleteDomain}
              disabled={busy === "delete"}
              className="h-6 border-red-300 px-2 text-red-700 hover:bg-red-50"
            >
              {busy === "delete" ? <Loader2 size={12} className="animate-spin" /> : "Delete"}
            </Button>
            <button className="text-muted-foreground hover:underline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
