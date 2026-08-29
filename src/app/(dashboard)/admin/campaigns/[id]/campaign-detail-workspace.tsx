"use client";

// Tabbed workspace for an existing native email campaign — the same shell the
// new-campaign builder uses. The sequence is edited in the Flow canvas (loaded
// from campaigns.flow_graph, or derived from campaign_steps for legacy rows);
// Save persists the graph + the derived linear steps + the schedule via
// /update-sequence. The other tabs reuse the existing stats / leads / probe cards.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Save,
  Loader2,
  Clock,
  Route,
  Workflow,
  Users,
  Calendar,
  SlidersHorizontal,
  ShieldCheck,
  BarChart3,
  AlertCircle,
  Inbox,
  Trophy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { appUrl } from "@/lib/api-url";
import { formatSendWindow, type SendWindowConfig, type CompletionProjection } from "@/lib/gmail/ramp";
import type { SendingStrategy } from "@/types/app";
import { type FlowGraph, graphToSteps, validateGraph } from "@/lib/flow/graph";
import { FlowEditor } from "@/components/campaigns/flow/flow-editor";
import { FlowProgress } from "@/components/campaigns/flow/flow-progress";
import { AbResults } from "@/components/campaigns/flow/ab-results";
import type { FlowProgressData } from "@/lib/flow/progress";
import type { AbNodeStats } from "@/lib/flow/variants";
import { NativeImportPanel } from "@/components/campaigns/native-import-panel";
import { CrmPullPanel } from "@/components/campaigns/crm-pull-panel";
import { CampaignProbeCard } from "@/components/campaigns/campaign-probe-card";
import { CampaignLifecycleButton } from "./campaign-lifecycle-button";
import { CampaignContactsCard, type CampaignContactRow } from "./campaign-contacts-card";
import { StageFlowCard, type StageRow } from "./stage-flow-card";
import { DeliverabilityCard, type DeliverabilityResult } from "./deliverability-card";

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

export interface NativeStatsView {
  sent: number;
  replied: number;
  bounced: number;
  enrollments: { active: number; completed: number; replied: number; failed: number };
  verification: { verified: number; risky: number; undeliverable: number; unverified: number };
  mailboxes: { email: string; status: string }[];
  dailyInboxCapacity: number;
  activeMailboxCount: number;
}

export function CampaignDetailWorkspace({
  campaignId,
  campaignName,
  status,
  sourceChannel,
  client,
  initialGraph,
  initialWindow,
  initialNewLeadsCap,
  initialStrategy,
  initialAbAutoPauseDefault,
  nativeStats,
  flowProgress,
  abStats,
  stageRows,
  projection,
  strategyLabel,
  contacts,
  contactsTruncated,
}: {
  campaignId: string;
  campaignName: string;
  status: "active" | "paused" | "draft" | "completed" | null;
  sourceChannel: string;
  client: { id: string; name: string } | null;
  initialGraph: FlowGraph;
  initialWindow: SendWindowConfig;
  initialNewLeadsCap: number;
  initialStrategy: SendingStrategy;
  initialAbAutoPauseDefault: boolean;
  nativeStats: NativeStatsView;
  flowProgress: FlowProgressData | null;
  abStats: AbNodeStats[];
  stageRows: StageRow[];
  projection: CompletionProjection | null;
  strategyLabel: string;
  contacts: CampaignContactRow[];
  contactsTruncated: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState("sequence");
  const [graph, setGraph] = useState<FlowGraph>(initialGraph);
  const [win, setWin] = useState<SendWindowConfig>(initialWindow);
  const [newLeadsCap, setNewLeadsCap] = useState<number>(initialNewLeadsCap);
  const [strategy, setStrategy] = useState<SendingStrategy>(initialStrategy);
  const [abAutoPauseDefault, setAbAutoPauseDefault] = useState<boolean>(initialAbAutoPauseDefault);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Deliverability pre-flight
  const [checkResult, setCheckResult] = useState<DeliverabilityResult | null>(null);
  const [checkLoading, setCheckLoading] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const graphError = validateGraph(graph);
    if (graphError) {
      setTab("sequence");
      return setError(graphError);
    }
    const steps = graphToSteps(graph).map((s) => ({
      wait_days: s.wait_days,
      subject_template: s.subject_template,
      body_template: s.body_template,
    }));
    setSaving(true);
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/update-sequence`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          steps,
          flow_graph: graph,
          send_timezone: win.timezone,
          send_start_hour: win.startHour,
          send_end_hour: win.endHour,
          send_weekdays_only: win.weekdaysOnly,
          daily_new_leads_cap: newLeadsCap,
          sending_strategy: strategy,
          ab_auto_pause_default: abAutoPauseDefault,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Save failed.");
        return;
      }
      setSavedAt(Date.now());
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runCheck() {
    setCheckLoading(true);
    setCheckError(null);
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/deliverability`));
      const data = (await res.json()) as DeliverabilityResult & { error?: string };
      if (!res.ok) {
        setCheckError(data.error ?? "Check failed.");
        return;
      }
      setCheckResult(data);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckLoading(false);
    }
  }

  const terminal = {
    replied: nativeStats.enrollments.replied,
    completed: nativeStats.enrollments.completed,
    failed: nativeStats.enrollments.failed,
  };
  const totals = {
    active: nativeStats.enrollments.active,
    enrolled:
      nativeStats.enrollments.active +
      nativeStats.enrollments.completed +
      nativeStats.enrollments.replied +
      nativeStats.enrollments.failed,
    sent: nativeStats.sent,
  };

  return (
    <div className="flex h-[calc(100vh-8.5rem)] min-h-0 flex-col">
      {/* header */}
      <div className="flex items-center justify-between gap-4 pb-2">
        <div className="min-w-0">
          <Link
            href="/admin/campaigns"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            ← Campaigns
          </Link>
          <div className="mt-0.5 flex items-center gap-2.5">
            <h1 className="truncate text-xl font-bold tracking-tight text-foreground">{campaignName}</h1>
            <Badge
              variant="secondary"
              className={
                status === "active" ? "badge-green" : status === "paused" ? "badge-amber" : "badge-slate"
              }
            >
              {status}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {client ? (
              <>
                <Link href={`/admin/clients/${client.id}`} className="underline">
                  {client.name}
                </Link>{" "}
                · Native email
              </>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-700">
                <AlertCircle size={12} /> Orphan campaign — not linked to a client
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {error && <span className="max-w-xs text-sm text-red-600">{error}</span>}
          {savedAt && !error && !saving && <span className="text-sm text-emerald-600">Saved</span>}
          <CampaignLifecycleButton
            campaignId={campaignId}
            campaignName={campaignName}
            status={status}
            sourceChannel={sourceChannel}
          />
          <Button onClick={save} disabled={saving} className="gap-1.5 text-white" style={{ background: "#2E37FE" }}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)} className="min-h-0 flex-1">
        <TabsList variant="line" className="shrink-0 gap-1">
          <TabsTrigger value="sequence">
            <Workflow /> Sequence
          </TabsTrigger>
          <TabsTrigger value="leads">
            <Users /> Contacts
          </TabsTrigger>
          <TabsTrigger value="schedule">
            <Calendar /> Schedule
          </TabsTrigger>
          <TabsTrigger value="options">
            <SlidersHorizontal /> Setup
          </TabsTrigger>
          <TabsTrigger value="deliverability">
            <ShieldCheck /> Deliverability
          </TabsTrigger>
          <TabsTrigger value="analytics">
            <BarChart3 /> Analytics
          </TabsTrigger>
        </TabsList>

        {/* Sequence — the Flow canvas */}
        <TabsContent value="sequence" className="flex min-h-0 flex-col pt-2">
          <FlowEditor
            value={graph}
            onChange={setGraph}
            campaignId={campaignId}
            abAutoPauseDefault={abAutoPauseDefault}
          />
        </TabsContent>

        {/* Leads */}
        <TabsContent value="leads" className="min-h-0 space-y-4 overflow-y-auto pt-4">
          <NativeImportPanel campaignId={campaignId} />
          <CrmPullPanel campaignId={campaignId} />
          <CampaignContactsCard
            campaignId={campaignId}
            contacts={contacts}
            truncated={contactsTruncated}
            canEnroll
          />
        </TabsContent>

        {/* Schedule + strategy */}
        <TabsContent value="schedule" className="min-h-0 overflow-y-auto pt-4">
          <div className="max-w-3xl space-y-5">
            <div className="space-y-3 rounded-xl border border-border/60 p-4">
              <p className="inline-flex items-center gap-1.5 text-sm font-medium">
                <Clock size={14} /> Sending schedule
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-secondary-foreground">Timezone</label>
                  <select
                    value={win.timezone}
                    onChange={(e) => setWin((w) => ({ ...w, timezone: e.target.value }))}
                    className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm"
                  >
                    {TIMEZONES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-secondary-foreground">Start</label>
                  <select
                    value={win.startHour}
                    onChange={(e) => setWin((w) => ({ ...w, startHour: Number(e.target.value) }))}
                    className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm"
                  >
                    {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                      <option key={h} value={h}>
                        {fmtHour12(h)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-secondary-foreground">End</label>
                  <select
                    value={win.endHour}
                    onChange={(e) => setWin((w) => ({ ...w, endHour: Number(e.target.value) }))}
                    className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm"
                  >
                    {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                      <option key={h} value={h}>
                        {fmtHour12(h)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-secondary-foreground">Days</label>
                  <label className="flex h-[34px] cursor-pointer items-center gap-2 rounded-md border border-border/60 px-2 text-sm">
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
                <div className="w-32 shrink-0 space-y-1">
                  <label className="text-xs font-medium text-secondary-foreground">New leads / day</label>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={newLeadsCap}
                    onChange={(e) =>
                      setNewLeadsCap(Math.max(0, Math.min(1000, Math.floor(Number(e.target.value) || 0))))
                    }
                    className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm"
                  />
                </div>
                <p className="pb-2 text-[11px] text-muted-foreground">{formatSendWindow(win)}</p>
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-border/60 p-4">
              <p className="inline-flex items-center gap-1.5 text-sm font-medium">
                <Route size={14} /> Sending strategy
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <StrategyOption
                  active={strategy === "finish_first"}
                  onClick={() => setStrategy("finish_first")}
                  title="Finish the sequence first"
                  desc="Follow-ups get priority; new leads drip in at the cap. Steady and predictable — slower reach."
                />
                <StrategyOption
                  active={strategy === "reach_first"}
                  onClick={() => setStrategy("reach_first")}
                  title="Reach everyone first"
                  desc="First-touches get priority and use full inbox capacity. Email #1 reaches the whole list fast."
                />
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-border/60 p-4">
              <p className="inline-flex items-center gap-1.5 text-sm font-medium">
                <Trophy size={14} /> A/B auto-winner
              </p>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={abAutoPauseDefault}
                  onChange={(e) => setAbAutoPauseDefault(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-indigo-600"
                />
                <span className="text-sm">
                  <span className="font-medium text-secondary-foreground">
                    Auto-pause losing variants by default
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Once an A/B step gathers enough sends, pause the losers so new leads route to
                    the winner — at 95% significance with a ≥1&nbsp;pt lead on positive-reply rate.
                    Sticky: a lead already in a variant’s thread stays there. Each A/B step can
                    override this default. Off unless you turn it on.
                  </span>
                </span>
              </label>
            </div>

            <p className="text-xs text-muted-foreground">Schedule changes save with the <strong>Save changes</strong> button above.</p>
          </div>
        </TabsContent>

        {/* Setup — client + mailbox pool */}
        <TabsContent value="options" className="min-h-0 overflow-y-auto pt-4">
          <div className="max-w-2xl space-y-5">
            <div>
              <p className="mb-1 text-xs font-medium text-secondary-foreground">Client</p>
              {client ? (
                <Link href={`/admin/clients/${client.id}`} className="text-sm underline">
                  {client.name}
                </Link>
              ) : (
                <p className="text-sm text-amber-700">Not linked to a client.</p>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-secondary-foreground">Sending mailboxes</p>
              {nativeStats.mailboxes.length === 0 ? (
                <p className="text-xs text-amber-700">No mailboxes assigned to this campaign.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {nativeStats.mailboxes.map((mb) => (
                    <Badge
                      key={mb.email}
                      variant="secondary"
                      className={
                        mb.status === "active" ? "badge-green" : mb.status === "error" ? "badge-red" : "badge-slate"
                      }
                    >
                      {mb.email}
                    </Badge>
                  ))}
                </div>
              )}
              {nativeStats.activeMailboxCount > 0 && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Combined capacity ~{nativeStats.dailyInboxCapacity}/day across {nativeStats.activeMailboxCount} active
                  inbox{nativeStats.activeMailboxCount === 1 ? "" : "es"} (warmup-aware).
                </p>
              )}
            </div>
          </div>
        </TabsContent>

        {/* Deliverability */}
        <TabsContent value="deliverability" className="min-h-0 space-y-4 overflow-y-auto pt-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={runCheck} disabled={checkLoading} className="gap-1.5">
              {checkLoading ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              {checkResult ? "Re-run pre-flight" : "Run pre-flight check"}
            </Button>
          </div>
          {(checkLoading || checkResult || checkError) && (
            <DeliverabilityCard result={checkResult} loading={checkLoading} error={checkError} />
          )}
          <CampaignProbeCard campaignId={campaignId} />
        </TabsContent>

        {/* Analytics */}
        <TabsContent value="analytics" className="min-h-0 space-y-4 overflow-y-auto pt-4">
          {flowProgress && <FlowProgress graph={initialGraph} data={flowProgress} />}
          {abStats.length > 0 && <AbResults stats={abStats} />}
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Sent" value={nativeStats.sent} color="text-[#2E37FE]" />
            <Stat label="Replied" value={nativeStats.replied} color="text-emerald-600" />
            <Stat
              label="Bounced"
              value={nativeStats.bounced}
              color={nativeStats.bounced > 0 ? "text-red-600" : "text-muted-foreground"}
            />
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Verified" value={nativeStats.verification.verified} color="text-emerald-600" />
            <Stat
              label="Risky"
              value={nativeStats.verification.risky}
              color={nativeStats.verification.risky > 0 ? "text-amber-600" : "text-muted-foreground"}
            />
            <Stat
              label="Undeliverable"
              value={nativeStats.verification.undeliverable}
              color={nativeStats.verification.undeliverable > 0 ? "text-red-600" : "text-muted-foreground"}
            />
            <Stat label="Unverified" value={nativeStats.verification.unverified} color="text-muted-foreground" />
          </div>
          {stageRows.length > 0 && projection ? (
            <StageFlowCard
              stages={stageRows}
              terminal={terminal}
              totals={totals}
              projection={projection}
              strategyLabel={strategyLabel}
            />
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
              <Inbox size={18} /> No stage data yet — activate the campaign and enroll leads to see the funnel.
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function StrategyOption({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border p-3 text-left transition-colors ${
        active ? "border-[#2E37FE] bg-[#2E37FE]/5 ring-1 ring-[#2E37FE]/30" : "border-border/60 hover:border-border"
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
            active ? "border-[#2E37FE]" : "border-muted-foreground/40"
          }`}
        >
          {active && <span className="h-2 w-2 rounded-full bg-[#2E37FE]" />}
        </span>
        <span className="text-sm font-semibold text-[#0f172a]">{title}</span>
      </span>
      <span className="mt-1.5 block text-[11px] leading-relaxed text-muted-foreground">{desc}</span>
    </button>
  );
}
