"use client";

// Tabbed workspace for an existing native email campaign — the same shell the
// new-campaign builder uses. The sequence is edited in the Flow canvas (loaded
// from campaigns.flow_graph, or derived from campaign_steps for legacy rows);
// Save persists the graph + the derived linear steps + the schedule via
// /update-sequence. The other tabs reuse the existing stats / leads / probe cards.

import { useEffect, useMemo, useRef, useState } from "react";
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
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DeleteCampaignDialog } from "@/components/campaigns/delete-campaign-dialog";
import { MailboxPoolPicker } from "@/components/campaigns/mailbox-pool-picker";
import { CampaignTagFollow } from "@/components/campaigns/campaign-tag-follow";
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

export interface SetupMailbox {
  id: string;
  email_address: string;
  status: string;
  tags: string[];
  // Dedicated-inbox policy: claimed by another non-completed campaign.
  inUse?: boolean;
  inUseBy?: string | null;
}

export function CampaignDetailWorkspace({
  campaignId,
  campaignName,
  status,
  sourceChannel,
  client,
  clients,
  allMailboxes,
  attachedMailboxIds,
  initialMailboxTag,
  contactsMissing,
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
  // All clients in the org (for the Setup client selector).
  clients: { id: string; name: string }[];
  // All sending mailboxes in the org (for the Setup pool selector).
  allMailboxes: SetupMailbox[];
  // Mailbox ids currently attached to this campaign.
  attachedMailboxIds: string[];
  // Live mailbox-tag this campaign follows (migration 00119), or null for the
  // classic manual pool. When set, the pool auto-syncs and the picker is locked.
  initialMailboxTag: string | null;
  // Whether the campaign still has zero enrolled contacts (drives the Contacts
  // tab badge). Server-computed from launch readiness.
  contactsMissing: boolean;
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

  // Setup tab — client link + mailbox pool are plain local edits (NO auto-save);
  // like the sequence + schedule, they persist only via the "Save changes"
  // button below. Local state also drives the badges.
  const [clientId, setClientId] = useState<string>(client?.id ?? "");
  const [mailboxIds, setMailboxIds] = useState<Set<string>>(new Set(attachedMailboxIds));
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Live mailbox-tag binding (migration 00119). When set, the pool auto-syncs to
  // the tag and the manual picker is locked. Bind/unbind is an immediate action
  // (CampaignTagFollow → its own PUT), so we key off the server prop and refresh.
  const boundTag = initialMailboxTag && initialMailboxTag.trim() ? initialMailboxTag : null;
  // Distinct tags present on the org's inboxes (case-insensitive, first casing
  // wins) — the tags a campaign can follow.
  const availableTags = useMemo(() => {
    const m = new Map<string, string>();
    for (const mb of allMailboxes) {
      for (const t of mb.tags ?? []) {
        const key = t.toLowerCase();
        if (!m.has(key)) m.set(key, t);
      }
    }
    return [...m.values()].sort((a, b) => a.localeCompare(b));
  }, [allMailboxes]);

  // Last-saved snapshot of every editable field. Nothing here auto-saves: the
  // Save button lights up only when the current state differs from this, and
  // leaving the page with a difference prompts to save.
  const [saved, setSaved] = useState(() => ({
    graph: initialGraph,
    win: initialWindow,
    cap: initialNewLeadsCap,
    strategy: initialStrategy,
    ab: initialAbAutoPauseDefault,
    clientId: client?.id ?? "",
    mailboxSig: [...attachedMailboxIds].sort().join(","),
  }));
  const mailboxSig = [...mailboxIds].sort().join(",");
  const seqScheduleDirty =
    JSON.stringify([graph, win, newLeadsCap, strategy, abAutoPauseDefault]) !==
    JSON.stringify([saved.graph, saved.win, saved.cap, saved.strategy, saved.ab]);
  const clientDirty = clientId !== saved.clientId;
  const mailboxesDirty = mailboxSig !== saved.mailboxSig;
  const dirty = seqScheduleDirty || clientDirty || mailboxesDirty;

  // Unsaved-changes exit guard. `beforeunload` covers reload / close / typing a
  // URL; a document-level capture click handler covers every in-app link (the
  // "← Campaigns" back link, the sidebar, the client "Open" link) so a click
  // that would navigate away opens the confirm dialog instead.
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const navigatingRef = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (navigatingRef.current || e.defaultPrevented) return;
      // Let modified clicks (open-in-new-tab) through untouched.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/")) return; // internal same-origin routes only
      if (a.target === "_blank" || a.hasAttribute("download")) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingHref(href);
      setLeaveOpen(true);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

  // Complete a guarded navigation. Strips the /app basePath so the SPA router
  // doesn't double it (rendered hrefs carry it; router.push re-adds it).
  function leaveTo(href: string | null) {
    navigatingRef.current = true;
    setLeaveOpen(false);
    if (href) {
      const path = href === "/app" ? "/" : href.startsWith("/app/") ? href.slice(4) : href;
      router.push(path);
    }
  }

  // Per-tab "missing sending-required setup" counts → the red count badges. The
  // Sequence and Setup counts derive from live local state so editing updates
  // the badge without a save; Contacts is server-computed (imports refresh the
  // route). This mirrors src/lib/campaigns/launch-readiness.ts.
  const seqSteps = graphToSteps(graph);
  const seqFirst = seqSteps[0];
  const sequenceMissing =
    seqSteps.length === 0 ||
    !seqFirst?.subject_template?.trim() ||
    !seqFirst?.body_template?.trim()
      ? 1
      : 0;
  const connectedMailboxCount = [...mailboxIds].filter(
    (id) => allMailboxes.find((m) => m.id === id)?.status === "active",
  ).length;
  const setupMissing = (clientId ? 0 : 1) + (connectedMailboxCount === 0 ? 1 : 0);
  const contactsBadge = contactsMissing ? 1 : 0;

  // Deliverability pre-flight
  const [checkResult, setCheckResult] = useState<DeliverabilityResult | null>(null);
  const [checkLoading, setCheckLoading] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // Persist only the groups that changed. Each group updates the saved snapshot
  // as it succeeds, so a mid-batch failure leaves the succeeded groups clean and
  // only the failed one dirty. Returns whether everything saved.
  async function save(): Promise<boolean> {
    setError(null);
    if (seqScheduleDirty) {
      const graphError = validateGraph(graph);
      if (graphError) {
        setTab("sequence");
        setError(graphError);
        return false;
      }
    }
    setSaving(true);
    const next = { ...saved };
    try {
      if (seqScheduleDirty) {
        const steps = graphToSteps(graph).map((s) => ({
          wait_days: s.wait_days,
          subject_template: s.subject_template,
          body_template: s.body_template,
        }));
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
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Couldn't save the sequence.");
        next.graph = graph;
        next.win = win;
        next.cap = newLeadsCap;
        next.strategy = strategy;
        next.ab = abAutoPauseDefault;
      }
      if (clientDirty) {
        const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/link-client`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: clientId || null }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Couldn't update the client.");
        next.clientId = clientId;
      }
      if (mailboxesDirty) {
        const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/mailboxes`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mailbox_ids: [...mailboxIds] }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Couldn't update the mailboxes.");
        next.mailboxSig = mailboxSig;
      }
      setSaved(next);
      setSavedAt(Date.now());
      router.refresh();
      return true;
    } catch (err) {
      setSaved(next); // keep whatever groups succeeded before the failure
      setError(err instanceof Error ? err.message : String(err));
      return false;
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

  // Header reflects the pending (local) client selection, so it stays in sync
  // with the Setup selector + badge before a save.
  const headerClient = clientId ? (clients.find((c) => c.id === clientId) ?? null) : null;
  const canSave = dirty && !saving;

  return (
    <div className="flex h-[calc(100vh-8.5rem)] min-h-0 flex-col">
      {/* header */}
      <div className="flex flex-col gap-3 pb-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
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
            {headerClient ? (
              <>
                <Link href={`/admin/clients/${headerClient.id}`} className="underline">
                  {headerClient.name}
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
          {dirty && !error && !saving && (
            <span className="text-sm text-amber-600">Unsaved changes</span>
          )}
          {!dirty && savedAt && !error && !saving && (
            <span className="text-sm text-emerald-600">Saved</span>
          )}
          <CampaignLifecycleButton
            campaignId={campaignId}
            campaignName={campaignName}
            status={status}
            sourceChannel={sourceChannel}
            disabled={dirty}
            disabledTitle="Save your changes first"
          />
          <Button
            onClick={() => void save()}
            disabled={!canSave}
            variant={canSave ? "default" : "secondary"}
            className="gap-1.5"
            style={canSave ? { background: "#2E37FE", color: "white" } : undefined}
            title={dirty ? undefined : "No unsaved changes"}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)} className="min-h-0 flex-1">
        <TabsList variant="line" className="shrink-0 gap-1">
          <TabsTrigger value="sequence">
            <Workflow /> Sequence <TabCount n={sequenceMissing} />
          </TabsTrigger>
          <TabsTrigger value="leads">
            <Users /> Contacts <TabCount n={contactsBadge} />
          </TabsTrigger>
          <TabsTrigger value="schedule">
            <Calendar /> Schedule
          </TabsTrigger>
          <TabsTrigger value="options">
            <SlidersHorizontal /> Setup <TabCount n={setupMissing} />
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

        {/* Setup — client link + mailbox pool (configurable at any time) + delete */}
        <TabsContent value="options" className="min-h-0 overflow-y-auto pt-4">
          <div className="max-w-2xl space-y-6">
            {/* Client link */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-secondary-foreground">Client</p>
              <div className="flex items-center gap-2">
                <select
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="w-full max-w-sm rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
                >
                  <option value="">— No client (orphan) —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {clientId && (
                  <Link
                    href={`/admin/clients/${clientId}`}
                    className="shrink-0 text-xs text-muted-foreground underline hover:text-foreground"
                  >
                    Open
                  </Link>
                )}
              </div>
              {!clientId && (
                <p className="inline-flex items-center gap-1 text-[11px] text-amber-700">
                  <AlertCircle size={11} /> Replies won&apos;t trigger client
                  notifications until a client is linked.
                </p>
              )}
            </div>

            {/* Sending mailbox pool */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-secondary-foreground">
                Sending mailboxes
              </p>
              <CampaignTagFollow
                campaignId={campaignId}
                boundTag={boundTag}
                availableTags={availableTags}
                onChanged={() => router.refresh()}
              />
              <MailboxPoolPicker
                mailboxes={allMailboxes}
                selected={mailboxIds}
                onChange={setMailboxIds}
                disabled={boundTag != null}
              />
              {boundTag != null && (
                <p className="text-[11px] text-muted-foreground">
                  This pool is managed by the tag above — inboxes sync
                  automatically. Unfollow to edit it by hand.
                </p>
              )}
              {nativeStats.activeMailboxCount > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Combined capacity ~{nativeStats.dailyInboxCapacity}/day across{" "}
                  {nativeStats.activeMailboxCount} active inbox
                  {nativeStats.activeMailboxCount === 1 ? "" : "es"} (warmup-aware).
                </p>
              )}
            </div>

            {/* Danger zone */}
            <div className="space-y-2 rounded-xl border border-red-200 bg-red-50/40 p-4">
              <p className="text-xs font-semibold text-red-700">Danger zone</p>
              <p className="text-[11px] text-muted-foreground">
                Permanently delete this campaign. Lead replies and contacts are
                preserved but lose their campaign link. This cannot be undone.
              </p>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDeleteOpen(true)}
                className="gap-1.5"
              >
                <Trash2 size={14} /> Delete campaign
              </Button>
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

      <DeleteCampaignDialog
        campaignId={campaignId}
        campaignName={campaignName}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => router.push("/admin/campaigns")}
      />

      {/* Unsaved-changes guard when leaving the page */}
      <Dialog
        open={leaveOpen}
        onOpenChange={(o) => {
          if (!o && !saving) {
            setLeaveOpen(false);
            setPendingHref(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes to this campaign. Save them before leaving?
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="ghost"
              onClick={() => {
                setLeaveOpen(false);
                setPendingHref(null);
              }}
              disabled={saving}
            >
              Keep editing
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => leaveTo(pendingHref)}
                disabled={saving}
              >
                Leave without saving
              </Button>
              <Button
                onClick={async () => {
                  const ok = await save();
                  if (ok) leaveTo(pendingHref);
                }}
                disabled={saving}
                className="gap-1.5"
                style={{ background: "#2E37FE", color: "white" }}
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save and exit
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Small red count badge on a tab — the "# still missing sending-required setup"
// for that category. Renders nothing at zero.
function TabCount({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">
      {n}
    </span>
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
