"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Inbox,
  Plus,
  Send,
  Pause,
  Play,
  Trash2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { bandBadgeClass, bandLabel } from "@/lib/deliverability/inbox-health";
import type { HealthComponent, NativeMailbox } from "@/types/app";

type MailboxRow = NativeMailbox & {
  sent_today: number;
  bounced_7d: number;
  effective_daily_cap: number;
  total_sent: number;
  warmed: boolean;
};

type Banner = { kind: "success" | "error"; message: string } | null;

export default function MailboxesPage() {
  const [mailboxes, setMailboxes] = useState<MailboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner>(null);

  // Add form
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newCap, setNewCap] = useState("20");
  const [adding, setAdding] = useState(false);

  // Per-row in-flight action guard (mailbox id → true)
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Which mailbox's health breakdown is expanded (only one at a time).
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(appUrl("/api/admin/mailboxes"));
      const data = await res.json();
      if (res.ok) setMailboxes(data.mailboxes ?? []);
      else setBanner({ kind: "error", message: data.error ?? "Failed to load mailboxes" });
    } catch (err) {
      setBanner({ kind: "error", message: err instanceof Error ? err.message : "Failed to load" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd() {
    if (!newEmail.trim()) return;
    setAdding(true);
    setBanner(null);
    try {
      const res = await fetch(appUrl("/api/admin/mailboxes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email_address: newEmail.trim(),
          display_name: newName.trim() || undefined,
          max_daily_cap: Number(newCap) || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setBanner({ kind: "success", message: `Added ${newEmail.trim()} — delegation verified.` });
        setNewEmail("");
        setNewName("");
        setNewCap("20");
        await load();
      } else {
        setBanner({ kind: "error", message: data.error ?? "Failed to add mailbox" });
      }
    } catch (err) {
      setBanner({ kind: "error", message: err instanceof Error ? err.message : "Failed to add" });
    } finally {
      setAdding(false);
    }
  }

  async function withBusy(id: string, fn: () => Promise<void>) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fn();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function handleToggleStatus(mb: MailboxRow) {
    const next = mb.status === "active" ? "paused" : "active";
    await withBusy(mb.id, async () => {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mb.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (res.ok) await load();
      else setBanner({ kind: "error", message: data.error ?? "Update failed" });
    });
  }

  async function handleTest(mb: MailboxRow) {
    setBanner(null);
    await withBusy(mb.id, async () => {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mb.id}/test`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        setBanner({
          kind: "success",
          message: `Test email sent from ${mb.email_address} to ${data.to}.`,
        });
        await load();
      } else {
        setBanner({ kind: "error", message: data.error ?? "Test send failed" });
        await load();
      }
    });
  }

  async function handleDelete(mb: MailboxRow) {
    if (!confirm(`Remove ${mb.email_address}? This can't be undone.`)) return;
    await withBusy(mb.id, async () => {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mb.id}`), { method: "DELETE" });
      const data = await res.json();
      if (res.ok) await load();
      else setBanner({ kind: "error", message: data.error ?? "Delete failed" });
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div
        className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]"
        style={{
          background: "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: "1px solid rgba(46,55,254,0.2)",
          borderTop: "1px solid rgba(46,55,254,0.3)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
        }}
      >
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Sending</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: "#0f172a", letterSpacing: "-0.01em" }}>
            Mailboxes
          </h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            Google Workspace inboxes LeadStart sends from directly. New inboxes
            ramp up automatically as they send — 5/day, then +1 each day up to a
            20/day cap — so a paused inbox never skips its warmup. No inbox ever
            sends more than 20/day.
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {banner && (
        <div
          className={
            banner.kind === "success"
              ? "flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3"
              : "flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3"
          }
        >
          {banner.kind === "success" ? (
            <CheckCircle size={16} className="text-emerald-500 shrink-0" />
          ) : (
            <XCircle size={16} className="text-red-500 shrink-0" />
          )}
          <span
            className={
              banner.kind === "success"
                ? "text-sm font-medium text-emerald-700"
                : "text-sm font-medium text-red-700"
            }
          >
            {banner.message}
          </span>
        </div>
      )}

      {/* Add mailbox */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EA4335]">
            <Plus size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">Add a mailbox</CardTitle>
            <p className="text-xs text-muted-foreground">
              We verify domain-wide delegation for this address before saving it.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-1">
              <Label htmlFor="newEmail" className="text-sm font-medium">
                Email address
              </Label>
              <Input
                id="newEmail"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="outreach@client-domain.com"
              />
            </div>
            <div className="space-y-1 sm:col-span-1">
              <Label htmlFor="newName" className="text-sm font-medium">
                Display name (optional)
              </Label>
              <Input
                id="newName"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Jane from Acme"
              />
            </div>
            <div className="space-y-1 sm:col-span-1">
              <Label htmlFor="newCap" className="text-sm font-medium">
                Daily cap (max 20)
              </Label>
              <Input
                id="newCap"
                type="number"
                min={1}
                max={20}
                value={newCap}
                onChange={(e) => setNewCap(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={handleAdd} disabled={adding || !newEmail.trim()} style={{ background: "#2E37FE" }}>
            {adding ? "Verifying…" : "Add mailbox"}
          </Button>
        </CardContent>
      </Card>

      {/* List */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500">
            <Inbox size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">
            Sending inboxes {mailboxes.length > 0 && <span className="text-muted-foreground font-normal">({mailboxes.length})</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
          ) : mailboxes.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No mailboxes yet. Add one above once its domain has authorized the
              service account in Google Admin.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Mailbox</th>
                    <th className="py-2 px-3 font-medium">Status</th>
                    <th className="py-2 px-3 font-medium">Health</th>
                    <th className="py-2 px-3 font-medium">Ramp</th>
                    <th className="py-2 px-3 font-medium">Today</th>
                    <th className="py-2 px-3 font-medium">Bounces 7d</th>
                    <th className="py-2 pl-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {mailboxes.map((mb) => (
                    <Fragment key={mb.id}>
                    <tr className="border-b last:border-0 align-middle">
                      <td className="py-3 pr-3">
                        <div className="font-medium text-[#0f172a]">{mb.email_address}</div>
                        {mb.display_name && (
                          <div className="text-xs text-muted-foreground">{mb.display_name}</div>
                        )}
                        {mb.status === "error" && mb.last_error && (
                          <div className="text-xs text-red-600 flex items-center gap-1 mt-0.5">
                            <AlertTriangle size={12} /> {mb.last_error}
                          </div>
                        )}
                        {mb.status === "paused" && mb.health_paused_at && (
                          <div className="text-xs text-amber-600 flex items-center gap-1 mt-0.5">
                            <AlertTriangle size={12} /> Paused automatically by the health check — resume when it recovers.
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <StatusBadge status={mb.status} />
                      </td>
                      <td className="py-3 px-3">
                        {mb.health_score == null ? (
                          <span
                            className="text-muted-foreground"
                            title="First health check runs within the hour."
                          >
                            —
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedId((cur) => (cur === mb.id ? null : mb.id))
                            }
                            className="inline-flex items-center gap-1.5 cursor-pointer"
                            title="Show the health breakdown"
                          >
                            <span className="font-semibold text-[#0f172a]">{mb.health_score}</span>
                            {mb.health_band && (
                              <Badge
                                variant="secondary"
                                className={`${bandBadgeClass(mb.health_band)} text-[10px]`}
                              >
                                {bandLabel(mb.health_band)}
                              </Badge>
                            )}
                            <ChevronDown
                              size={12}
                              className={`text-muted-foreground transition-transform ${expandedId === mb.id ? "rotate-180" : ""}`}
                            />
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        {mb.warmed ? (
                          <span className="text-emerald-600 font-medium">Warmed</span>
                        ) : (
                          <span className="text-muted-foreground">
                            Warming · {mb.total_sent} sent
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <span className="font-medium">{mb.sent_today}</span>
                        <span className="text-muted-foreground"> / {mb.effective_daily_cap}</span>
                      </td>
                      <td className="py-3 px-3">
                        <span className={mb.bounced_7d > 0 ? "text-amber-600 font-medium" : "text-muted-foreground"}>
                          {mb.bounced_7d}
                        </span>
                      </td>
                      <td className="py-3 pl-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy[mb.id]}
                            onClick={() => handleTest(mb)}
                            title="Send a test email from this inbox"
                          >
                            <Send size={14} />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy[mb.id]}
                            onClick={() => handleToggleStatus(mb)}
                            title={mb.status === "active" ? "Pause" : "Resume"}
                          >
                            {mb.status === "active" ? <Pause size={14} /> : <Play size={14} />}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy[mb.id]}
                            onClick={() => handleDelete(mb)}
                            title="Remove mailbox"
                          >
                            <Trash2 size={14} className="text-red-500" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {expandedId === mb.id && mb.health_components && (
                      <tr className="bg-slate-50/60 border-b last:border-0">
                        <td colSpan={7} className="px-3 py-3">
                          <div className="space-y-1.5">
                            {mb.health_components.map((c) => (
                              <div key={c.key} className="flex items-start gap-2 text-xs">
                                <span
                                  className={`mt-1 h-2 w-2 rounded-full shrink-0 ${dotClass(c.status)}`}
                                />
                                <span className="font-medium text-[#0f172a] w-44 shrink-0">
                                  {c.label}
                                </span>
                                <span className="text-muted-foreground">{c.detail}</span>
                              </div>
                            ))}
                            {mb.health_checked_at && (
                              <p className="text-[11px] text-muted-foreground pt-1">
                                Last checked {new Date(mb.health_checked_at).toLocaleString()}.
                              </p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function dotClass(status: HealthComponent["status"]): string {
  switch (status) {
    case "ok":
      return "bg-emerald-500";
    case "warn":
      return "bg-amber-500";
    case "bad":
      return "bg-red-500";
    case "unchecked":
      return "bg-slate-300";
  }
}

function StatusBadge({ status }: { status: NativeMailbox["status"] }) {
  if (status === "active") {
    return <Badge variant="secondary" className="badge-green text-[10px]">Active</Badge>;
  }
  if (status === "paused") {
    return <Badge variant="secondary" className="bg-slate-100 text-slate-600 border border-slate-200 text-[10px]">Paused</Badge>;
  }
  return <Badge variant="secondary" className="badge-red text-[10px]">Error</Badge>;
}
