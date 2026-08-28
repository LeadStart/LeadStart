"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, Loader2, Plus, KeyRound, Check } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { SendingDomain } from "@/types/app";

interface Workspace {
  id: string;
  label: string;
  admin_email: string;
  is_default: boolean;
}

const STEP_TITLES = ["Google Workspace", "Inbox names", "DNS"];

export function DomainSetupModal({
  domain,
  onClose,
  onDone,
}: {
  domain: SendingDomain;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsId, setWsId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [specs, setSpecs] = useState([{ local_part: "", display_name: "" }]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [passwords, setPasswords] = useState<{ email: string; password: string }[]>([]);
  const [done, setDone] = useState(false);

  const writesDns = domain.registrar !== "manual";

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/api/admin/workspaces"));
      if (!res.ok) return;
      const data = await res.json();
      const list: Workspace[] = data.workspaces ?? [];
      setWorkspaces(list);
      setWsId((cur) => cur ?? (list.find((w) => w.is_default)?.id ?? list[0]?.id ?? null));
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  async function addWorkspace() {
    if (!newLabel.trim() || !newEmail.trim()) return;
    setBusy("addws");
    setErr(null);
    try {
      const res = await fetch(appUrl("/api/admin/workspaces"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel.trim(), admin_email: newEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "Could not add that Workspace.");
        return;
      }
      await loadWorkspaces();
      setWsId(data.workspace?.id ?? null);
      setAdding(false);
      setNewLabel("");
      setNewEmail("");
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    const users = specs
      .map((s) => ({ local_part: s.local_part.trim().toLowerCase(), display_name: s.display_name.trim() }))
      .filter((s) => s.local_part);
    if (!users.length) {
      setErr("Add at least one inbox name.");
      return;
    }
    setBusy("start");
    setErr(null);
    try {
      const res = await fetch(appUrl(`/api/admin/domains/${domain.id}/workspace`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ users, workspace_id: wsId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "Setup could not start.");
        return;
      }
      if (Array.isArray(data.revealed_passwords)) setPasswords(data.revealed_passwords);
      setDone(true);
      onDone();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg max-h-[88vh] overflow-auto rounded-2xl border border-border bg-card shadow-xl">
        {/* header */}
        <div className="flex items-center gap-3 border-b border-border p-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 5L2 7" /></svg>
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Set up inboxes</h3>
            <p className="truncate font-mono text-xs text-muted-foreground">{domain.domain}</p>
          </div>
          <button onClick={onClose} className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-muted-foreground hover:bg-muted/70">
            <X size={15} />
          </button>
        </div>

        {done ? (
          <div className="p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-emerald-700">
              <Check size={16} /> Setup started for {domain.domain}
            </div>
            {passwords.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
                <div className="mb-1 flex items-center gap-1.5 font-medium text-amber-900">
                  <KeyRound size={13} /> Inbox passwords, shown once, not stored
                </div>
                <ul className="space-y-0.5 font-mono text-amber-900">
                  {passwords.map((p) => (
                    <li key={p.email}>{p.email}: <span className="select-all">{p.password}</span></li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              The domain now shows its provisioning progress in its row. Google verification and inbox
              creation finish in the background; expand the domain to watch, or use Check now.
            </p>
            <div className="mt-4 flex justify-end">
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : (
          <>
            {/* step bar */}
            <div className="flex gap-1.5 px-4 pt-4">
              {STEP_TITLES.map((t, i) => (
                <div key={t} className="flex-1 text-center text-[10.5px] font-semibold" style={{ color: i === step ? "var(--primary)" : "var(--muted-foreground)" }}>
                  <div className="mb-1.5 h-1 rounded" style={{ background: i <= step ? "var(--primary)" : "var(--border)" }} />
                  {t}
                </div>
              ))}
            </div>

            <div className="p-4">
              {err && <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{err}</div>}

              {/* Step 1: Workspace */}
              {step === 0 && (
                <div>
                  <Label className="text-xs">Which Google Workspace should this domain live on?</Label>
                  <div className="mt-2 space-y-1.5">
                    {workspaces.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => setWsId(w.id)}
                        className={`flex w-full items-center gap-2.5 rounded-lg border p-2.5 text-left ${wsId === w.id ? "border-primary bg-primary/5" : "border-border hover:border-border/70"}`}
                      >
                        <span className={`h-4 w-4 flex-none rounded-full border-2 ${wsId === w.id ? "border-primary bg-primary ring-2 ring-inset ring-white" : "border-slate-300"}`} />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium">{w.label}</span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">{w.admin_email}</span>
                        </span>
                        {w.is_default && <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">default</span>}
                      </button>
                    ))}
                    {workspaces.length === 0 && (
                      <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                        No Workspaces yet. Add one below (its admin still needs to authorize the service account first).
                      </p>
                    )}
                  </div>

                  {adding ? (
                    <div className="mt-3 space-y-2 rounded-lg border border-border p-3">
                      <Label className="text-xs">Name it</Label>
                      <Input placeholder="e.g. Acme Outreach" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
                      <Label className="text-xs">Workspace super-admin email</Label>
                      <Input placeholder="admin@acme.com" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="font-mono text-xs" />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={addWorkspace} disabled={busy === "addws" || !newLabel.trim() || !newEmail.trim()}>
                          {busy === "addws" ? <Loader2 size={13} className="animate-spin" /> : "Add Workspace"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAdding(true)}>
                      <Plus size={13} /> Add and name a Workspace
                    </Button>
                  )}
                </div>
              )}

              {/* Step 2: Inboxes */}
              {step === 1 && (
                <div>
                  <Label className="text-xs">Name the inboxes you want (up to 3)</Label>
                  <div className="mt-2 space-y-2">
                    {specs.map((s, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          placeholder="jane"
                          value={s.local_part}
                          onChange={(e) => { const n = specs.slice(); n[i] = { ...n[i], local_part: e.target.value }; setSpecs(n); }}
                          className="flex-1 font-mono text-xs"
                        />
                        <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">@{domain.domain}</span>
                        <Input
                          placeholder="Display name"
                          value={s.display_name}
                          onChange={(e) => { const n = specs.slice(); n[i] = { ...n[i], display_name: e.target.value }; setSpecs(n); }}
                          className="flex-1"
                        />
                        {specs.length > 1 && (
                          <button type="button" onClick={() => setSpecs(specs.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-red-600">
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {specs.length < 3 && (
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => setSpecs([...specs, { local_part: "", display_name: "" }])}>
                      <Plus size={13} /> Add inbox
                    </Button>
                  )}
                </div>
              )}

              {/* Step 3: DNS */}
              {step === 2 && (
                <div>
                  <Label className="text-xs">DNS for {domain.domain}</Label>
                  <div className="mt-2 max-h-40 overflow-auto rounded-lg border border-border">
                    <table className="w-full font-mono text-[11px]">
                      <tbody>
                        <tr><td className="px-3 py-2 text-muted-foreground">MX</td><td className="px-3 py-2">@</td><td className="px-3 py-2 break-all">smtp.google.com (1)</td></tr>
                        <tr><td className="px-3 py-2 text-muted-foreground">TXT</td><td className="px-3 py-2">@</td><td className="px-3 py-2 break-all">v=spf1 include:_spf.google.com ~all</td></tr>
                        <tr><td className="px-3 py-2 text-muted-foreground">TXT</td><td className="px-3 py-2">_dmarc</td><td className="px-3 py-2 break-all">v=DMARC1; p=none;</td></tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-border p-3">
                    <span className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full ${writesDns ? "bg-emerald-500" : "bg-slate-300"} text-white`}>
                      {writesDns ? <Check size={11} /> : null}
                    </span>
                    <div className="text-xs">
                      {writesDns ? (
                        <><b className="font-medium">Written to {domain.registrar} automatically.</b> <span className="text-muted-foreground">This domain is at a connected registrar, so LeadStart writes the DNS for you.</span></>
                      ) : (
                        <><b className="font-medium">You&rsquo;ll add these by hand.</b> <span className="text-muted-foreground">This domain is set to manual. To auto-write, track it with a connected registrar instead.</span></>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* footer */}
            <div className="flex gap-2 border-t border-border p-4">
              <Button variant="outline" onClick={() => setStep(step - 1)} className={step === 0 ? "invisible" : ""}>Back</Button>
              <span className="flex-1" />
              {step < 2 ? (
                <Button onClick={() => setStep(step + 1)} disabled={step === 0 && !wsId}>Next</Button>
              ) : (
                <Button onClick={start} disabled={busy === "start"}>
                  {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : "Create inboxes"}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
