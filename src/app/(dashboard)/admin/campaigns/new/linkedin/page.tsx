"use client";

// /admin/campaigns/new/linkedin — sequence builder for LinkedIn campaigns.
// Minimum viable: name + client + step list. No drag/drop — steps are
// reordered with up/down buttons (and the default step set is sane). The
// saved campaign lands as status='draft' so nothing fires until the owner
// activates it from the campaign detail page.

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
import type { Client, SequenceStepKind } from "@/types/app";

type StepDraft = {
  kind: SequenceStepKind;
  wait_days: number;
  body_template: string;
};

const KIND_LABELS: Record<SequenceStepKind, string> = {
  connect_request: "Connection request",
  message: "Direct message",
  inmail: "InMail (Sales Nav)",
  like_post: "Like a recent post",
  profile_visit: "Profile visit",
};

const KIND_HINTS: Record<SequenceStepKind, string> = {
  connect_request:
    "Sends a connection request, optionally with a 1-line note.",
  message:
    "Sends a direct message. Only fires once the recipient is connected.",
  inmail:
    "Sends an InMail via Sales Navigator. Consumes Sales Nav credits.",
  like_post:
    "Likes the contact's most recent post. Soft-touch warmup; no message.",
  profile_visit:
    "Visits the contact's profile (counts as a soft-touch).",
};

const DEFAULT_STEPS: StepDraft[] = [
  {
    kind: "connect_request",
    wait_days: 0,
    body_template:
      "Hi {{first_name}} — saw your work at {{company}} and wanted to connect.",
  },
  {
    kind: "message",
    wait_days: 3,
    body_template:
      "Thanks for connecting, {{first_name}}. Quick question — does {{company}} currently struggle with [problem]? Happy to share what's worked for similar teams.",
  },
  {
    kind: "message",
    wait_days: 5,
    body_template:
      "Following up — worth a 15-min chat to see if there's a fit?",
  },
  {
    kind: "message",
    wait_days: 7,
    body_template:
      "Closing the loop here. If timing's off, no worries — feel free to reach out anytime.",
  },
];

type ClientWithAccount = Pick<
  Client,
  "id" | "name" | "unipile_account_id" | "unipile_account_status"
>;

export default function NewLinkedinCampaignPage() {
  const router = useRouter();
  const { organizationId } = useUser();
  const [clients, setClients] = useState<ClientWithAccount[]>([]);
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<string>("");
  const [steps, setSteps] = useState<StepDraft[]>(DEFAULT_STEPS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId) return;
    const supabase = createClient();
    supabase
      .from("clients")
      .select("id, name, unipile_account_id, unipile_account_status")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .order("name")
      .then(({ data }: { data: unknown }) => {
        if (Array.isArray(data)) {
          setClients(data as ClientWithAccount[]);
        }
      });
  }, [organizationId]);

  const selectedClient = clients.find((c) => c.id === clientId) ?? null;
  const accountReady =
    selectedClient?.unipile_account_status === "connected" &&
    Boolean(selectedClient?.unipile_account_id);

  function updateStep<K extends keyof StepDraft>(
    index: number,
    key: K,
    value: StepDraft[K],
  ) {
    setSteps((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [key]: value };
      return next;
    });
    setError(null);
  }

  function addStep() {
    setSteps((prev) => [
      ...prev,
      { kind: "message", wait_days: 3, body_template: "" },
    ]);
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
    if (!name.trim()) {
      setError("Give the campaign a name.");
      return;
    }
    if (!clientId) {
      setError("Pick a client.");
      return;
    }
    if (!accountReady) {
      setError(
        "This client doesn't have a connected LinkedIn account yet. Connect one from the client detail page first.",
      );
      return;
    }
    if (steps.length === 0) {
      setError("Add at least one step.");
      return;
    }
    for (const [i, s] of steps.entries()) {
      if (s.kind === "connect_request" || s.kind === "message" || s.kind === "inmail") {
        if (!s.body_template.trim()) {
          setError(`Step ${i + 1} (${KIND_LABELS[s.kind]}) needs a message body.`);
          return;
        }
      }
    }

    setSaving(true);
    try {
      const res = await fetch(appUrl("/api/admin/campaigns/linkedin"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          client_id: clientId,
          unipile_account_id: selectedClient?.unipile_account_id ?? null,
          steps: steps.map((s, i) => ({
            step_index: i,
            kind: s.kind,
            wait_days: s.wait_days,
            body_template: s.body_template,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Save failed (${res.status})`);
      }
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
        <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a] mt-3" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
          <div className="relative z-10">
            <p className="text-xs font-medium text-[#64748b]">New Campaign</p>
            <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>
              LinkedIn sequence
            </h1>
            <p className="text-sm text-[#0f172a]/60 mt-1">
              Build a multi-step outreach sequence. Saved as a draft — nothing dispatches
              until you activate it from the campaign detail page.
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
                placeholder="Q2 LinkedIn outreach — agency owners"
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
                      if (typeof value !== "string" || !value)
                        return "Pick a client";
                      return (
                        clients.find((c) => c.id === value)?.name ?? value
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.unipile_account_status !== "connected" && " — LinkedIn not connected"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedClient && !accountReady && (
                <p className="text-xs text-amber-700">
                  This client doesn&apos;t have a connected LinkedIn account. Connect
                  one from{" "}
                  <Link
                    href={`/admin/clients/${selectedClient.id}`}
                    className="underline"
                  >
                    their client page
                  </Link>{" "}
                  before saving.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">Steps</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addStep}
            className="gap-1.5"
          >
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
            <div
              key={i}
              className="rounded-xl border border-border/50 p-4 space-y-3"
            >
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-[#0A66C2] px-2 text-xs font-bold text-white">
                  {i + 1}
                </span>
                <Select
                  value={step.kind}
                  onValueChange={(v) => v && updateStep(i, "kind", v as SequenceStepKind)}
                >
                  <SelectTrigger className="w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(KIND_LABELS) as SequenceStepKind[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {KIND_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => moveStep(i, -1)}
                    disabled={i === 0}
                    aria-label="Move up"
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => moveStep(i, 1)}
                    disabled={i === steps.length - 1}
                    aria-label="Move down"
                  >
                    <ArrowDown size={14} />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => removeStep(i)}
                    aria-label="Remove step"
                    className="text-red-600 hover:text-red-700"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">{KIND_HINTS[step.kind]}</p>
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
                    onChange={(e) =>
                      updateStep(i, "wait_days", Math.max(0, Number(e.target.value) || 0))
                    }
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Days to wait after the previous step.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`body-${i}`} className="text-xs">
                    Message
                  </Label>
                  <Textarea
                    id={`body-${i}`}
                    rows={3}
                    placeholder={
                      step.kind === "like_post" || step.kind === "profile_visit"
                        ? "(no message — engagement only)"
                        : "Use {{first_name}} and {{company}} as placeholders."
                    }
                    value={step.body_template}
                    onChange={(e) => updateStep(i, "body_template", e.target.value)}
                    disabled={
                      step.kind === "like_post" || step.kind === "profile_visit"
                    }
                  />
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="gap-1.5 text-white"
          style={{ background: "#0A66C2" }}
        >
          <Save size={14} />
          {saving ? "Saving…" : "Save sequence"}
        </Button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
