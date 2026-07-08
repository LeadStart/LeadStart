"use client";

// /admin/campaigns/[id]/edit — edit a Salesforge campaign.
//
// Bundles:
//   - Step editor (subject + body + reorder + add/remove)
//   - Mailbox assignment
//   - Sending schedule editor (per-weekday hour windows)
//   - Email validation flow (start, poll, confirm, skip)
//
// Read-only for non-Salesforge campaigns (just shows a message
// pointing the user to whatever edit surface that channel uses).

import { useEffect, useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Plus,
  Trash2,
  Save,
  Send,
  Loader2,
  AlertCircle,
  CheckCircle,
  Clock,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { appUrl } from "@/lib/api-url";

interface StepDraft {
  id: string;
  subject: string;
  body: string;
  wait_days: number;
}

interface SequenceDetail {
  id: string;
  name: string;
  status?: string;
  productId?: string;
  workspaceId?: string;
  steps?: Array<{
    id: string;
    name?: string;
    waitDays: number;
    variants?: Array<{
      emailSubject?: string;
      emailContent?: string;
    }>;
  }>;
  mailboxes?: Array<{ id: string; address: string }>;
}

interface MailboxOption {
  id: string;
  email: string;
  status?: string;
}

interface ScheduleDraft {
  weekday: number;
  fromHour: number;
  toHour: number;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DEFAULT_SCHEDULE: ScheduleDraft[] = [
  { weekday: 1, fromHour: 9, toHour: 17 },
  { weekday: 2, fromHour: 9, toHour: 17 },
  { weekday: 3, fromHour: 9, toHour: 17 },
  { weekday: 4, fromHour: 9, toHour: 17 },
  { weekday: 5, fromHour: 9, toHour: 17 },
];

interface ValidationResult {
  status?: string;
  progress?: number;
  result?: Record<string, Record<string, number>>;
}

export default function EditCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: campaignId } = use(params);
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sequence, setSequence] = useState<SequenceDetail | null>(null);

  const [name, setName] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [allMailboxes, setAllMailboxes] = useState<MailboxOption[]>([]);
  const [selectedMailboxIds, setSelectedMailboxIds] = useState<string[]>([]);
  const [schedules, setSchedules] = useState<ScheduleDraft[]>(DEFAULT_SCHEDULE);

  const [savingMain, setSavingMain] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [saveResult, setSaveResult] = useState<"success" | "fail" | null>(null);

  // Validation state.
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validationBusy, setValidationBusy] = useState(false);

  const loadSequence = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [seqRes, mbRes] = await Promise.all([
        fetch(appUrl(`/api/admin/salesforge/sequences/${campaignId}`)).then((r) => r.json()),
        fetch(appUrl(`/api/admin/salesforge/mailboxes`)).then((r) => r.json()),
      ]);
      if (seqRes.error) throw new Error(seqRes.error);
      const seq = seqRes.sequence as SequenceDetail;
      setSequence(seq);
      setName(seq.name ?? "");
      setSteps(
        (seq.steps ?? []).map((s) => ({
          id: s.id,
          subject: s.variants?.[0]?.emailSubject ?? "",
          body: s.variants?.[0]?.emailContent ?? "",
          wait_days: s.waitDays ?? 0,
        })),
      );
      setSelectedMailboxIds((seq.mailboxes ?? []).map((m) => m.id));
      if (Array.isArray(mbRes.mailboxes)) setAllMailboxes(mbRes.mailboxes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void loadSequence();
  }, [loadSequence]);

  function updateStep(idx: number, patch: Partial<StepDraft>) {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function moveStep(idx: number, dir: -1 | 1) {
    setSteps((prev) => {
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }
  function addStep() {
    setSteps((prev) => [...prev, { id: "", subject: "", body: "", wait_days: 3 }]);
  }
  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  }
  function toggleMailbox(id: string) {
    setSelectedMailboxIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function updateSchedule(idx: number, patch: Partial<ScheduleDraft>) {
    setSchedules((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function addSchedule() {
    setSchedules((prev) => [...prev, { weekday: 1, fromHour: 9, toHour: 17 }]);
  }
  function removeSchedule(idx: number) {
    setSchedules((prev) => prev.filter((_, i) => i !== idx));
  }

  async function saveMain() {
    setSavingMain(true);
    setSaveResult(null);
    try {
      const res = await fetch(appUrl(`/api/admin/salesforge/sequences/${campaignId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          steps: steps.map((s) => ({
            id: s.id,
            subject: s.subject,
            body: s.body,
            wait_days: s.wait_days,
          })),
          mailbox_ids: selectedMailboxIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
      setSaveResult("success");
      await loadSequence();
    } catch (err) {
      setSaveResult("fail");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingMain(false);
    }
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    try {
      const res = await fetch(
        appUrl(`/api/admin/salesforge/sequences/${campaignId}/schedule`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schedules }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Schedule save failed (${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSchedule(false);
    }
  }

  async function callValidation(action: "start" | "skip" | "confirm" | "result") {
    setValidationBusy(true);
    try {
      const url = appUrl(`/api/admin/salesforge/sequences/${campaignId}/validation`);
      const res =
        action === "result"
          ? await fetch(url)
          : await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action, esps: ["gmail", "gsuite", "outlook", "ms365", "yahoo"] }),
            });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${action} failed (${res.status})`);
      if (action === "result") setValidation(data);
      // Refresh result after start/confirm/skip.
      if (action !== "result") {
        const r2 = await fetch(url);
        const d2 = await r2.json();
        if (r2.ok) setValidation(d2);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidationBusy(false);
    }
  }

  async function setSequenceStatus(status: "active" | "paused") {
    try {
      const path = status === "active" ? "resume" : "pause";
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/${path}`), {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Status change failed (${res.status})`);
      await loadSequence();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        <Loader2 size={20} className="inline animate-spin mr-2" />
        Loading sequence…
      </div>
    );
  }

  if (!sequence) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link href={appUrl("/admin/campaigns")}>
          <Button variant="ghost" size="sm"><ArrowLeft size={14} className="mr-1" /> Back</Button>
        </Link>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{error || "Sequence not found."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-2">
        <Link href={appUrl("/admin/campaigns")}>
          <Button variant="ghost" size="sm"><ArrowLeft size={14} className="mr-1" /> Back to campaigns</Button>
        </Link>
      </div>

      <div className="relative overflow-hidden rounded-[12px] p-5 sm:p-7 text-[#0f172a]" style={{ background: "#EDEEFF", border: "1px solid #e2e8f0" }}>
        <p className="text-xs font-medium text-[#64748b]">Salesforge sequence</p>
        <h1 className="text-[20px] sm:text-[22px] font-bold mt-1">Edit: {sequence.name}</h1>
        <div className="mt-2 flex items-center gap-2">
          <Badge className={sequence.status === "active" ? "badge-green" : "badge-amber"}>
            {sequence.status}
          </Badge>
          {sequence.status === "active" && (
            <Button size="sm" variant="outline" onClick={() => setSequenceStatus("paused")}>
              Pause
            </Button>
          )}
          {sequence.status === "paused" && (
            <Button size="sm" variant="outline" onClick={() => setSequenceStatus("active")}>
              Resume
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Basics + steps + mailboxes (single Save button at the bottom) */}
      <Card>
        <CardHeader><CardTitle className="text-base">Basics</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="name">Sequence name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={savingMain}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Sending mailboxes</CardTitle></CardHeader>
        <CardContent>
          {allMailboxes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No mailboxes connected.</p>
          ) : (
            <div className="space-y-2">
              {allMailboxes.map((m) => (
                <label key={m.id} className="flex items-center gap-3 rounded-lg border border-border/60 p-3 cursor-pointer hover:bg-muted/30">
                  <input
                    type="checkbox"
                    checked={selectedMailboxIds.includes(m.id)}
                    onChange={() => toggleMailbox(m.id)}
                    disabled={savingMain}
                  />
                  <span className="text-sm font-medium flex-1">{m.email}</span>
                  {m.status && (
                    <Badge variant="secondary" className={m.status === "active" ? "badge-green" : "bg-gray-100 text-gray-500"}>
                      {m.status}
                    </Badge>
                  )}
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Steps</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {steps.map((step, idx) => (
            <div key={idx} className="rounded-lg border border-border/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Step {idx + 1}</h3>
                <div className="flex items-center gap-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => moveStep(idx, -1)} disabled={idx === 0 || savingMain}>
                    <ArrowUp size={14} />
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => moveStep(idx, 1)} disabled={idx === steps.length - 1 || savingMain}>
                    <ArrowDown size={14} />
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => removeStep(idx)} disabled={steps.length === 1 || savingMain}>
                    <Trash2 size={14} className="text-red-600" />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_120px]">
                <div className="space-y-1">
                  <Label>Subject</Label>
                  <Input value={step.subject} onChange={(e) => updateStep(idx, { subject: e.target.value })} disabled={savingMain} />
                </div>
                <div className="space-y-1">
                  <Label>Wait days</Label>
                  <Input type="number" min={0} value={step.wait_days} onChange={(e) => updateStep(idx, { wait_days: Math.max(0, parseInt(e.target.value) || 0) })} disabled={savingMain || idx === 0} />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Body</Label>
                <Textarea value={step.body} onChange={(e) => updateStep(idx, { body: e.target.value })} rows={6} disabled={savingMain} />
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" onClick={addStep} disabled={savingMain}>
            <Plus size={14} className="mr-1" /> Add step
          </Button>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button onClick={saveMain} disabled={savingMain} style={{ background: "#2E37FE" }}>
          {savingMain ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Save size={14} className="mr-1" />}
          Save changes
        </Button>
        {saveResult === "success" && (
          <span className="text-sm text-emerald-600 flex items-center gap-1">
            <CheckCircle size={14} /> Saved
          </span>
        )}
      </div>

      {/* Schedule editor */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock size={16} /> Sending schedule
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Each row defines a sending window for one weekday. Hours are
            in the sequence&apos;s timezone.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {schedules.map((s, idx) => (
            <div key={idx} className="flex items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Day</Label>
                <select
                  value={s.weekday}
                  onChange={(e) => updateSchedule(idx, { weekday: parseInt(e.target.value) })}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  disabled={savingSchedule}
                >
                  {WEEKDAY_LABELS.map((label, i) => (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">From hour</Label>
                <Input type="number" min={0} max={23} value={s.fromHour} onChange={(e) => updateSchedule(idx, { fromHour: Math.max(0, Math.min(23, parseInt(e.target.value) || 0)) })} disabled={savingSchedule} className="w-20" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">To hour</Label>
                <Input type="number" min={0} max={23} value={s.toHour} onChange={(e) => updateSchedule(idx, { toHour: Math.max(0, Math.min(23, parseInt(e.target.value) || 0)) })} disabled={savingSchedule} className="w-20" />
              </div>
              <Button size="sm" variant="ghost" onClick={() => removeSchedule(idx)} disabled={savingSchedule}>
                <Trash2 size={14} className="text-red-600" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={addSchedule} disabled={savingSchedule}>
              <Plus size={14} className="mr-1" /> Add window
            </Button>
            <Button onClick={saveSchedule} disabled={savingSchedule} style={{ background: "#2E37FE" }}>
              {savingSchedule ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Save size={14} className="mr-1" />}
              Save schedule
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Email validation */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck size={16} /> Email validation
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Verify enrolled contacts&apos; deliverability before sending.
            Salesforge charges for validation runs — check your plan
            limits before starting.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => callValidation("start")} disabled={validationBusy} variant="outline" size="sm">
              {validationBusy ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Send size={14} className="mr-1" />}
              Start validation
            </Button>
            <Button onClick={() => callValidation("result")} disabled={validationBusy} variant="outline" size="sm">
              Refresh status
            </Button>
            <Button onClick={() => callValidation("confirm")} disabled={validationBusy} variant="outline" size="sm">
              Confirm + proceed
            </Button>
            <Button onClick={() => callValidation("skip")} disabled={validationBusy} variant="outline" size="sm">
              Skip validation
            </Button>
          </div>
          {validation && (
            <div className="rounded-lg border border-border/60 p-3 text-xs">
              <p className="font-medium">Status: {validation.status} ({validation.progress ?? 0}%)</p>
              {validation.result && (
                <pre className="mt-2 overflow-x-auto text-[11px] text-muted-foreground">
                  {JSON.stringify(validation.result, null, 2)}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
