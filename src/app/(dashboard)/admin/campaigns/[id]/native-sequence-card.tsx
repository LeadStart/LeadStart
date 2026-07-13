"use client";

// Sequence + send-window card for a native email campaign. Read-only by
// default (real subjects + full bodies + cadence + schedule); an Edit toggle
// turns every step and the send window into editable fields, persisted via
// /api/admin/campaigns/[id]/update-sequence.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Pencil, Plus, Trash2, ArrowUp, ArrowDown, Save, X, Loader2, Clock } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { formatSendWindow, type SendWindowConfig } from "@/lib/gmail/ramp";
import { StepCopyCheck } from "@/components/campaigns/step-copy-check";

interface StepDraft {
  subject: string;
  body: string;
  wait_days: number;
}

const TIMEZONES = [
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Phoenix", label: "Arizona" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/New_York", label: "Eastern" },
];

function fmtHour12(h: number): string {
  const hr = ((h % 24) + 24) % 24;
  const period = hr < 12 || hr === 24 ? "AM" : "PM";
  const twelve = hr % 12 === 0 ? 12 : hr % 12;
  return `${twelve} ${period}`;
}

export function NativeSequenceCard({
  campaignId,
  initialSteps,
  initialWindow,
  initialNewLeadsCap,
}: {
  campaignId: string;
  initialSteps: StepDraft[];
  initialWindow: SendWindowConfig;
  initialNewLeadsCap: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [steps, setSteps] = useState<StepDraft[]>(initialSteps);
  const [win, setWin] = useState<SendWindowConfig>(initialWindow);
  const [newLeadsCap, setNewLeadsCap] = useState<number>(initialNewLeadsCap);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetAndClose() {
    setSteps(initialSteps);
    setWin(initialWindow);
    setNewLeadsCap(initialNewLeadsCap);
    setError(null);
    setEditing(false);
  }

  function updateStep(i: number, patch: Partial<StepDraft>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function addStep() {
    setSteps((prev) => [...prev, { subject: "", body: "", wait_days: 3 }]);
  }
  function removeStep(i: number) {
    setSteps((prev) => prev.filter((_, idx) => idx !== i));
  }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps((prev) => {
      const t = i + dir;
      if (t < 0 || t >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[t]] = [next[t], next[i]];
      return next;
    });
  }

  async function save() {
    setError(null);
    if (steps.length === 0) return setError("Add at least one step.");
    if (!steps[0].subject.trim()) return setError("The first step needs a subject.");
    for (const [i, s] of steps.entries()) {
      if (!s.body.trim()) return setError(`Step ${i + 1} needs an email body.`);
    }
    setSaving(true);
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/update-sequence`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          steps: steps.map((s) => ({
            wait_days: s.wait_days,
            subject_template: s.subject,
            body_template: s.body,
          })),
          send_timezone: win.timezone,
          send_start_hour: win.startHour,
          send_end_hour: win.endHour,
          send_weekdays_only: win.weekdaysOnly,
          daily_new_leads_cap: newLeadsCap,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Save failed.");
        return;
      }
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // ---------------- Read mode ----------------
  if (!editing) {
    const firstSubject = steps[0]?.subject || "(no subject)";
    return (
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="text-base">Sequence &amp; schedule</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1">
              <Clock size={12} /> {formatSendWindow(win)} ·{" "}
              {newLeadsCap === 0
                ? "new leads paused"
                : `up to ${newLeadsCap} new lead${newLeadsCap === 1 ? "" : "s"}/day`}
            </p>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditing(true)}>
            <Pencil size={14} /> Edit
          </Button>
        </CardHeader>
        <CardContent>
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No steps configured.</p>
          ) : (
            <ol className="space-y-3">
              {steps.map((s, i) => {
                const subject =
                  i === 0
                    ? s.subject || "(no subject)"
                    : s.subject.trim()
                      ? s.subject
                      : `Re: ${firstSubject}`;
                return (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-[#EA4335] px-2 text-xs font-bold text-white shrink-0">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-[#0f172a]">{subject}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.wait_days === 0
                          ? "Sends immediately"
                          : `Waits ${s.wait_days} day${s.wait_days === 1 ? "" : "s"} after the previous step`}
                      </p>
                      {s.body && (
                        <pre className="mt-2 whitespace-pre-wrap break-words rounded-md border border-border/40 bg-muted/30 p-3 font-sans text-xs leading-relaxed text-[#334155]">
                          {s.body}
                        </pre>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    );
  }

  // ---------------- Edit mode ----------------
  return (
    <Card className="border-[#2E37FE]/40 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Edit sequence &amp; schedule</CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={resetAndClose} disabled={saving} className="gap-1">
            <X size={14} /> Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving} className="gap-1.5 text-white" style={{ background: "#2E37FE" }}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Send window */}
        <div className="rounded-lg border border-border/50 p-4 space-y-3">
          <p className="text-sm font-medium inline-flex items-center gap-1.5">
            <Clock size={14} /> Sending schedule
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1">
              <Label className="text-xs">Timezone</Label>
              <select
                value={win.timezone}
                onChange={(e) => setWin((w) => ({ ...w, timezone: e.target.value }))}
                className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm"
              >
                {TIMEZONES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Start</Label>
              <select
                value={win.startHour}
                onChange={(e) => setWin((w) => ({ ...w, startHour: Number(e.target.value) }))}
                className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm"
              >
                {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                  <option key={h} value={h}>{fmtHour12(h)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">End</Label>
              <select
                value={win.endHour}
                onChange={(e) => setWin((w) => ({ ...w, endHour: Number(e.target.value) }))}
                className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm"
              >
                {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                  <option key={h} value={h}>{fmtHour12(h)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Days</Label>
              <label className="flex h-[34px] items-center gap-2 rounded-md border border-border/60 px-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={win.weekdaysOnly}
                  onChange={(e) => setWin((w) => ({ ...w, weekdaysOnly: e.target.checked }))}
                  className="h-4 w-4 accent-[#2E37FE]"
                />
                Weekdays only
              </label>
            </div>
          </div>
          <div className="flex items-end gap-3 pt-1">
            <div className="space-y-1 w-32 shrink-0">
              <Label className="text-xs">New leads / day</Label>
              <Input
                type="number"
                min={0}
                max={1000}
                value={newLeadsCap}
                onChange={(e) =>
                  setNewLeadsCap(Math.max(0, Math.min(1000, Math.floor(Number(e.target.value) || 0))))
                }
              />
            </div>
            <p className="text-[11px] text-muted-foreground pb-2">
              New first-touches started per day on this campaign. Follow-ups aren&apos;t
              limited by this — set 0 to pause new leads while replies keep sending.
            </p>
          </div>
          <p className="text-[11px] text-muted-foreground">{formatSendWindow(win)}</p>
        </div>

        {/* Steps */}
        <div className="space-y-3">
          {steps.map((s, i) => (
            <div key={i} className="rounded-xl border border-border/50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-[#EA4335] px-2 text-xs font-bold text-white">
                  {i + 1}
                </span>
                <span className="text-sm font-medium">{i === 0 ? "First email" : "Follow-up"}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button type="button" size="icon" variant="ghost" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move up">
                    <ArrowUp size={14} />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} aria-label="Move down">
                    <ArrowDown size={14} />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" onClick={() => removeStep(i)} aria-label="Remove" className="text-red-600 hover:text-red-700">
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[110px_1fr]">
                <div className="space-y-1">
                  <Label className="text-xs">Wait (days)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={365}
                    value={s.wait_days}
                    onChange={(e) => updateStep(i, { wait_days: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </div>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Subject</Label>
                    <Input
                      placeholder={i === 0 ? "Subject line" : "Leave blank to thread as “Re: <first subject>”"}
                      value={s.subject}
                      onChange={(e) => updateStep(i, { subject: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Body</Label>
                    <Textarea
                      rows={8}
                      placeholder="Placeholders: {{FirstName}} {{PropertyAddress}} {{SoldDate}} {{YourName}}"
                      value={s.body}
                      onChange={(e) => updateStep(i, { body: e.target.value })}
                    />
                    <StepCopyCheck
                      subject={s.subject}
                      body={s.body}
                      campaignId={campaignId}
                      onApplySpintax={(n) => updateStep(i, { subject: n.subject ?? s.subject, body: n.body })}
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addStep} className="gap-1.5">
            <Plus size={14} /> Add step
          </Button>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
      </CardContent>
    </Card>
  );
}
