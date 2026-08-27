"use client";

// /admin/campaigns/new/native — native email campaign workspace. Instantly-style
// tabbed layout: the sequence is a full-height Flow canvas on its own tab; client
// + mailboxes live under Options; the probe under Deliverability. On save we derive
// the linear campaign_steps the sender executes (graphToSteps) AND persist the full
// authored graph in campaigns.flow_graph. Saved as status='draft'.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ArrowLeft,
  Save,
  Workflow,
  Users,
  Calendar,
  SlidersHorizontal,
  ShieldCheck,
  BarChart3,
} from "lucide-react";
import Link from "next/link";
import { appUrl } from "@/lib/api-url";
import { useUser } from "@/hooks/use-user";
import { CampaignProbeCard } from "@/components/campaigns/campaign-probe-card";
import { FlowEditor } from "@/components/campaigns/flow/flow-editor";
import { type FlowGraph, graphToSteps, validateGraph, starterGraph } from "@/lib/flow/graph";
import type { Client, NativeMailbox } from "@/types/app";

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
  const [graph, setGraph] = useState<FlowGraph>(starterGraph);
  const [tab, setTab] = useState("sequence");
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

  async function handleSave() {
    setError(null);
    if (!name.trim()) return setError("Give the campaign a name.");
    if (!clientId) {
      setTab("options");
      return setError("Pick a client under Setup.");
    }
    if (selectedMailboxes.size === 0) {
      setTab("options");
      return setError("Select at least one sending mailbox under Setup.");
    }
    const graphError = validateGraph(graph);
    if (graphError) {
      setTab("sequence");
      return setError(graphError);
    }

    const steps = graphToSteps(graph).map((s, i) => ({
      step_index: i,
      wait_days: s.wait_days,
      subject_template: s.subject_template,
      body_template: s.body_template,
    }));

    setSaving(true);
    try {
      const res = await fetch(appUrl("/api/admin/campaigns/native"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          client_id: clientId,
          mailbox_ids: [...selectedMailboxes],
          steps,
          flow_graph: graph,
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
    <div className="flex h-[calc(100vh-8.5rem)] min-h-0 flex-col">
      {/* header */}
      <div className="flex items-center justify-between gap-4 pb-2">
        <div className="min-w-0">
          <Link
            href="/admin/campaigns"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={13} /> Campaigns
          </Link>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled campaign"
            className="w-full max-w-xl bg-transparent text-xl font-bold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40"
          />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {error && <span className="max-w-xs text-sm text-red-600">{error}</span>}
          <Button
            onClick={handleSave}
            disabled={saving}
            className="gap-1.5 text-white"
            style={{ background: "#2E37FE" }}
          >
            <Save size={14} />
            {saving ? "Saving…" : "Save draft"}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)} className="min-h-0 flex-1">
        <TabsList variant="line" className="shrink-0 gap-1">
          <TabsTrigger value="options">
            <SlidersHorizontal /> Setup
          </TabsTrigger>
          <TabsTrigger value="sequence">
            <Workflow /> Sequence
          </TabsTrigger>
          <TabsTrigger value="leads">
            <Users /> Leads
          </TabsTrigger>
          <TabsTrigger value="schedule">
            <Calendar /> Schedule
          </TabsTrigger>
          <TabsTrigger value="deliverability">
            <ShieldCheck /> Deliverability
          </TabsTrigger>
          <TabsTrigger value="analytics">
            <BarChart3 /> Analytics
          </TabsTrigger>
        </TabsList>

        {/* Sequence — the full-height Flow canvas */}
        <TabsContent value="sequence" className="flex min-h-0 flex-col pt-2">
          <FlowEditor value={graph} onChange={setGraph} clientId={clientId || undefined} />
        </TabsContent>

        {/* Options — client + sending mailboxes */}
        <TabsContent value="options" className="min-h-0 overflow-y-auto pt-4">
          <div className="max-w-2xl space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                        className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-sm hover:bg-muted/40"
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
          </div>
        </TabsContent>

        {/* Leads — pre-save empty state */}
        <TabsContent value="leads" className="min-h-0 overflow-y-auto pt-4">
          <div className="flex max-w-2xl flex-col items-start gap-2 rounded-xl border border-dashed border-border p-6">
            <Users size={22} className="text-muted-foreground" />
            <p className="text-sm font-medium">Add leads after you save</p>
            <p className="text-sm text-muted-foreground">
              Once the campaign is saved you can import a CSV or assign contacts, and pre-send verification runs before the
              first email.
            </p>
          </div>
        </TabsContent>

        {/* Schedule — defaults for a new campaign */}
        <TabsContent value="schedule" className="min-h-0 overflow-y-auto pt-4">
          <div className="max-w-2xl space-y-3 rounded-xl border border-border p-5 text-sm">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <span className="text-muted-foreground">Sending days</span>
              <span className="font-medium">Mon–Fri</span>
            </div>
            <div className="flex items-center justify-between border-b border-border pb-2">
              <span className="text-muted-foreground">Hours</span>
              <span className="font-medium">8:00 AM – 5:00 PM</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Timezone</span>
              <span className="font-medium">Lead-local</span>
            </div>
            <p className="pt-1 text-xs text-muted-foreground">
              Starter defaults — fine-tune the window, weekdays, and daily new-lead cap from the campaign after you save.
            </p>
          </div>
        </TabsContent>

        {/* Deliverability — the probe */}
        <TabsContent value="deliverability" className="min-h-0 overflow-y-auto pt-4">
          <CampaignProbeCard />
        </TabsContent>

        {/* Analytics — empty until activated */}
        <TabsContent value="analytics" className="min-h-0 overflow-y-auto pt-4">
          <div className="flex max-w-2xl flex-col items-start gap-2 rounded-xl border border-dashed border-border p-6">
            <BarChart3 size={22} className="text-muted-foreground" />
            <p className="text-sm font-medium">No data yet</p>
            <p className="text-sm text-muted-foreground">
              Sends, replies, bounces, and the stage funnel appear here once you activate the campaign.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
