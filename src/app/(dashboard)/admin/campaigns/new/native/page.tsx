"use client";

// /admin/campaigns/new/native — sequence builder for native email campaigns
// (LeadStart sends directly from Google Workspace inboxes). Mirrors the
// LinkedIn builder: name + client + step list, saved as status='draft' so
// nothing sends until the owner activates it. Adds a subject line on the
// first step and a rotation pool of sending mailboxes.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, ArrowDown, ArrowUp, Plus, Trash2, Save } from "lucide-react";
import Link from "next/link";
import { appUrl } from "@/lib/api-url";
import { useUser } from "@/hooks/use-user";
import { StepCopyCheck } from "@/components/campaigns/step-copy-check";
import type { Client, NativeMailbox } from "@/types/app";

type StepDraft = {
  wait_days: number;
  subject_template: string; // only used on step 0
  body_template: string;
};

const DEFAULT_STEPS: StepDraft[] = [
  {
    wait_days: 0,
    subject_template: "Quick question, {{first_name}}",
    body_template:
      "Hi {{first_name}},\n\n{{intro_line}}\n\nDoes {{company}} currently struggle with [problem]? Happy to share what's worked for similar teams.\n\nBest,\n[Your name]",
  },
  {
    wait_days: 3,
    subject_template: "",
    body_template:
      "Just following up, {{first_name}} — worth a quick 15-minute chat to see if there's a fit?",
  },
  {
    wait_days: 5,
    subject_template: "",
    body_template:
      "Closing the loop here. If the timing's off, no worries — feel free to reach out anytime.",
  },
];

type ClientOption = Pick<Client, "id" | "name">;
type MailboxOption = Pick<NativeMailbox, "id" | "email_address" | "status">;

export default function NewNativeCampaignPage() {
  const router = useRouter();
  const { organizationId } = useUser();
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<string>("");
  const [selectedMailboxes, setSelectedMailboxes] = useState<Set<string>>(new Set());
  const [steps, setSteps] = useState<StepDraft[]>(DEFAULT_STEPS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId) return;
    const supabase = createClient();
    supabase
      .from("clients")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .order("name")
      .then(({ data }: { data: unknown }) => {
        if (Array.isArray(data)) setClients(data as ClientOption[]);
      });
    // Mailboxes live on a no-RLS table — load through the owner-scoped API.
    fetch(appUrl("/api/admin/mailboxes"))
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.mailboxes)) setMailboxes(d.mailboxes as MailboxOption[]);
      })
      .catch(() => {});
  }, [organizationId]);

  const activeMailboxes = mailboxes.filter((m) => m.status === "active");

  function toggleMailbox(id: string) {
    setSelectedMailboxes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setError(null);
  }

  function updateStep<K extends keyof StepDraft>(index: number, key: K, value: StepDraft[K]) {
    setSteps((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [key]: value };
      return next;
    });
    setError(null);
  }

  function addStep() {
    setSteps((prev) => [...prev, { wait_days: 3, subject_template: "", body_template: "" }]);
  }

  function removeStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  function moveStep(index: number, dir: -1 | 1) {
    setSteps((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function handleSave() {
    setError(null);
    if (!name.trim()) return setError("Give the campaign a name.");
    if (!clientId) return setError("Pick a client.");
    if (selectedMailboxes.size === 0) return setError("Select at least one sending mailbox.");
    if (steps.length === 0) return setError("Add at least one step.");
    if (!steps[0].subject_template.trim()) return setError("The first step needs a subject line.");
    for (const [i, s] of steps.entries()) {
      if (!s.body_template.trim()) return setError(`Step ${i + 1} needs an email body.`);
    }

    setSaving(true);
    try {
      const res = await fetch(appUrl("/api/admin/campaigns/native"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          client_id: clientId,
          mailbox_ids: [...selectedMailboxes],
          steps: steps.map((s, i) => ({
            step_index: i,
            wait_days: s.wait_days,
            subject_template: i === 0 ? s.subject_template : s.subject_template || null,
            body_template: s.body_template,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
      router.push(`/admin/clients/${clientId}/campaigns/${data.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/campaigns"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> Back to Campaigns
        </Link>
        <div
          className="relative overflow-hidden rounded-[12px] p-5 sm:p-7 text-[#0f172a] mt-3"
          style={{
            background: "#EDEEFF",
            border: "1px solid #e2e8f0",
            borderTop: "1px solid #e2e8f0",
            boxShadow: "none",
          }}
        >
          <div className="relative z-10">
            <p className="text-xs font-medium text-[#64748b]">New Campaign</p>
            <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: "#0f172a", letterSpacing: "-0.01em" }}>
              Native email sequence
            </h1>
            <p className="text-sm text-[#0f172a]/60 mt-1">
              Sends directly from your Google inboxes. Saved as a draft — nothing
              sends until you activate it from the campaign detail page.
            </p>
          </div>
        </div>
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Basics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">Campaign name</Label>
              <Input
                id="name"
                placeholder="Q3 email outreach — HVAC owners"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="client">Client</Label>
              <Select value={clientId} onValueChange={(v) => setClientId(v ?? "")}>
                <SelectTrigger id="client">
                  <SelectValue placeholder="Pick a client">
                    {(value) => {
                      if (typeof value !== "string" || !value) return "Pick a client";
                      return clients.find((c) => c.id === value)?.name ?? value;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Sending mailboxes</Label>
            {activeMailboxes.length === 0 ? (
              <p className="text-xs text-amber-700">
                No active mailboxes.{" "}
                <Link href="/admin/mailboxes" className="underline">
                  Add one under Sending → Mailboxes
                </Link>{" "}
                first.
              </p>
            ) : (
              <>
                <p className="text-[11px] text-muted-foreground">
                  Emails rotate across the selected inboxes, paced per inbox.
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {activeMailboxes.map((mb) => (
                    <label
                      key={mb.id}
                      className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40"
                    >
                      <input
                        type="checkbox"
                        checked={selectedMailboxes.has(mb.id)}
                        onChange={() => toggleMailbox(mb.id)}
                        className="h-4 w-4 accent-[#2E37FE]"
                      />
                      <span>{mb.email_address}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">Steps</CardTitle>
          <Button type="button" variant="outline" size="sm" onClick={addStep} className="gap-1.5">
            <Plus size={14} /> Add step
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {steps.length === 0 && (
            <p className="text-sm text-muted-foreground italic">
              No steps yet. Click &quot;Add step&quot; to start.
            </p>
          )}
          {steps.map((step, i) => (
            <div key={i} className="rounded-xl border border-border/50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-[#EA4335] px-2 text-xs font-bold text-white">
                  {i + 1}
                </span>
                <span className="text-sm font-medium">
                  {i === 0 ? "First email" : "Follow-up (same thread)"}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <Button type="button" size="icon" variant="ghost" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move up">
                    <ArrowUp size={14} />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} aria-label="Move down">
                    <ArrowDown size={14} />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" onClick={() => removeStep(i)} aria-label="Remove step" className="text-red-600 hover:text-red-700">
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[120px_1fr]">
                <div className="space-y-1.5">
                  <Label htmlFor={`wait-${i}`} className="text-xs">
                    Wait (days)
                  </Label>
                  <Input
                    id={`wait-${i}`}
                    type="number"
                    min={0}
                    max={365}
                    value={step.wait_days}
                    onChange={(e) => updateStep(i, "wait_days", Math.max(0, Number(e.target.value) || 0))}
                  />
                  <p className="text-[10px] text-muted-foreground">Days after the previous step.</p>
                </div>
                <div className="space-y-3">
                  {i === 0 ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={`subject-${i}`} className="text-xs">
                        Subject
                      </Label>
                      <Input
                        id={`subject-${i}`}
                        placeholder="Use {{first_name}}, {{company}} as placeholders."
                        value={step.subject_template}
                        onChange={(e) => updateStep(i, "subject_template", e.target.value)}
                      />
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Sends as <span className="font-mono">Re: [first subject]</span> in the same thread.
                    </p>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor={`body-${i}`} className="text-xs">
                      Body
                    </Label>
                    <Textarea
                      id={`body-${i}`}
                      rows={6}
                      placeholder="Plain text. Placeholders: {{first_name}} {{last_name}} {{company}} {{title}} {{intro_line}}"
                      value={step.body_template}
                      onChange={(e) => updateStep(i, "body_template", e.target.value)}
                    />
                    <StepCopyCheck
                      subject={i === 0 ? step.subject_template : ""}
                      body={step.body_template}
                      clientId={clientId || undefined}
                      onApplySpintax={(n) => {
                        if (i === 0 && n.subject !== null) updateStep(i, "subject_template", n.subject);
                        updateStep(i, "body_template", n.body);
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving} className="gap-1.5 text-white" style={{ background: "#2E37FE" }}>
          <Save size={14} />
          {saving ? "Saving…" : "Save sequence"}
        </Button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
