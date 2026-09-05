// Top-level campaign detail page. Orphan-safe (works regardless of
// client_id). For native_email campaigns this renders send/reply stats, the
// mailbox pool, an inline CSV import panel, and the sequence editor. Per-client
// detail at /admin/clients/[clientId]/campaigns/[campaignId] is the older view
// this one is what list rows link to from /admin/campaigns.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { KPICard } from "@/components/charts/kpi-card";
import { DailyChart } from "@/components/charts/daily-chart";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { resolveSendWindow, formatSendWindow, resolveDailyNewLeadsCap, resolveSendingStrategy, effectiveDailyCap, projectSequenceCompletion, type CompletionProjection } from "@/lib/gmail/ramp";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Inbox, Upload, CheckCircle2 } from "lucide-react";
import { NativeImportPanel } from "@/components/campaigns/native-import-panel";
import { CampaignContactsCard, type CampaignContactRow } from "./campaign-contacts-card";
import { NativeSequenceSection } from "./native-sequence-section";
import { CampaignProbeCard } from "@/components/campaigns/campaign-probe-card";
import { StageFlowCard, type StageRow } from "./stage-flow-card";
import { CampaignLifecycleButton } from "./campaign-lifecycle-button";
import { gatherLaunchReadiness } from "@/lib/campaigns/launch-readiness";
import { mailboxUsageMap } from "@/lib/campaigns/mailbox-usage";
import { LaunchReadinessCard } from "@/components/campaigns/launch-readiness-card";
import { CampaignDetailWorkspace } from "./campaign-detail-workspace";
import { stepsToGraph, walkAll, isAbTest, type FlowGraph } from "@/lib/flow/graph";
import {
  computeFlowProgress,
  type FlowProgressData,
  type ProgressEnrollment,
} from "@/lib/flow/progress";
import { computeVariantStats, type AbNodeStats } from "@/lib/flow/variants";
import type { Campaign, CampaignSnapshot, Client, ReplyClass } from "@/types/app";

const SNAPSHOT_COLUMNS =
  "id, campaign_id, snapshot_date, total_leads, emails_sent, replies, " +
  "unique_replies, cohort_replies, positive_replies, bounces, unsubscribes, meetings_booked, " +
  "new_leads_contacted, reply_rate, positive_reply_rate, bounce_rate, " +
  "unsubscribe_rate, fetched_at";

export default async function AdminCampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: campaignId } = await params;
  const supabase = await createClient();

  const { data: campaignRow } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (!campaignRow) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Campaign not found.</p>
      </div>
    );
  }

  const campaign = campaignRow as Campaign;
  const sendWindow = resolveSendWindow(campaign);
  const sendSchedule = formatSendWindow(sendWindow);
  const sendingStrategy = resolveSendingStrategy(campaign);
  const strategyLabel =
    sendingStrategy === "reach_first" ? "Reach everyone first" : "Finish the sequence first";
  // The queue-state counts go through the admin client because the
  // client-scoped supabase respects RLS that would hide queue rows from
  // the owner if any policy is misconfigured. Admin client is fine here
  // since the page is already owner-gated by the dashboard layout.
  const admin = createAdminClient();

  // Launch readiness (native email): the checklist the detail page shows + the
  // rule that gates the Launch button. Cheap; computed for native campaigns only.
  const launchReadiness =
    campaign.source_channel === "native_email"
      ? await gatherLaunchReadiness(admin, { id: campaign.id, client_id: campaign.client_id })
      : null;

  const [clientRes, snapshotsRes, orgClientsRes] =
    await Promise.all([
      campaign.client_id
        ? supabase
            .from("clients")
            .select("id, name")
            .eq("id", campaign.client_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("campaign_snapshots")
        .select(SNAPSHOT_COLUMNS)
        .eq("campaign_id", campaignId)
        .order("snapshot_date", { ascending: false }),
      // Every client in the org: feeds both the orphan-linker card (legacy
      // render) and the Setup tab's client selector, which can re-point or
      // unlink the campaign at any time.
      supabase
        .from("clients")
        .select("id, name")
        .eq("organization_id", campaign.organization_id)
        .order("name"),
    ]);

  const client = clientRes.data as { id: string; name: string } | null;
  const snapshots = (snapshotsRes.data ?? []) as unknown as CampaignSnapshot[];
  const orgClients = (orgClientsRes.data ?? []) as Pick<
    Client,
    "id" | "name"
  >[];

  const metrics = calculateMetrics(snapshots);

  // Native email campaigns pull their stats straight from
  // native_sends / lead_replies / campaign_enrollments.
  const nativeStats =
    campaign.source_channel === "native_email"
      ? await nativeStatsFor(admin, campaignId)
      : null;

  // Contacts assigned to this campaign (contacts.campaign_id) joined with
  // their sequence-enrollment state. Assignment alone does not send: the
  // dispatcher works exclusively off campaign_enrollments, so the card shows
  // both facts per contact. Capped at the newest 1000 rows.
  const CONTACTS_CAP = 1000;
  const [assignedRes, campEnrollRes] = await Promise.all([
    admin
      .from("contacts")
      .select(
        "id, first_name, last_name, email, email_verification_status, company_name, title, created_at",
      )
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })
      .limit(CONTACTS_CAP),
    admin
      .from("campaign_enrollments")
      .select("contact_id, status, current_step_index")
      .eq("campaign_id", campaignId),
  ]);
  const enrollmentByContact = new Map(
    (
      (campEnrollRes.data ?? []) as {
        contact_id: string;
        status: string;
        current_step_index: number | null;
      }[]
    ).map((e) => [
      e.contact_id,
      { status: e.status, current_step_index: e.current_step_index },
    ]),
  );
  const campaignContacts: CampaignContactRow[] = (
    (assignedRes.data ?? []) as Omit<CampaignContactRow, "enrollment">[]
  ).map((c) => ({ ...c, enrollment: enrollmentByContact.get(c.id) ?? null }));
  const contactsTruncated = campaignContacts.length === CONTACTS_CAP;

  // Stage-flow view model + completion projection for the "Contacts by sending
  // stage" panel. Resolve each step's display subject (later steps thread as
  // "Re: <first subject>" when they carry no own subject, matching the sender)
  // and a human cadence label, then pair with the per-step waiting/sent counts.
  const stageRows: StageRow[] = [];
  let projection: CompletionProjection | null = null;
  if (nativeStats && nativeStats.steps.length > 0) {
    const firstSubject = nativeStats.steps[0]?.subject || "(no subject)";
    nativeStats.steps.forEach((s, i) => {
      const subject =
        i === 0
          ? s.subject || "(no subject)"
          : s.subject.trim()
            ? s.subject
            : `Re: ${firstSubject}`;
      const cadence =
        s.wait_days === 0
          ? "Sends immediately"
          : `Waits ${s.wait_days} day${s.wait_days === 1 ? "" : "s"}${i === 0 ? "" : " after the previous step"}`;
      stageRows.push({
        index: i,
        subject,
        cadence,
        waiting: nativeStats.waitingByStep[i] ?? 0,
        sent: nativeStats.sentByStep[i] ?? 0,
      });
    });
    const newLeadsCap = resolveDailyNewLeadsCap(campaign);
    projection = projectSequenceCompletion({
      firstTouchesRemaining: nativeStats.waitingByStep[0] ?? 0,
      // reach_first drains first-touches at full warmed inbox capacity; finish_first
      // throttles them to the new-leads/day cap. A cap of 0 pauses either way.
      firstTouchesPerDay:
        sendingStrategy === "reach_first" ? nativeStats.dailyInboxCapacity : newLeadsCap,
      newLeadsPaused: newLeadsCap <= 0,
      stepWaitDays: nativeStats.steps.map((s) => s.wait_days),
      waitingByStep: nativeStats.waitingByStep,
      weekdaysOnly: sendWindow.weekdaysOnly,
      strategy: sendingStrategy,
      mailboxCount: nativeStats.activeMailboxCount,
    });
  }

  // Native email campaigns render the tabbed Flow workspace (same shell as the
  // new-campaign builder). Load the authored graph from campaigns.flow_graph,
  // falling back to a linear graph derived from campaign_steps for legacy rows.
  if (campaign.source_channel === "native_email" && nativeStats) {
    const stored = (campaign as unknown as { flow_graph?: FlowGraph | null }).flow_graph;
    const isFlowCampaign =
      !!stored && typeof stored === "object" && Array.isArray((stored as FlowGraph).nodes);
    const initialGraph: FlowGraph = isFlowCampaign
      ? (stored as FlowGraph)
      : stepsToGraph(
          nativeStats.steps.map((s) => ({
            wait_days: s.wait_days,
            subject_template: s.subject || null,
            body_template: s.body,
          })),
        );

    // Flow-progress: live per-node occupancy + reply-outcome rollup for the
    // read-only branch view. Only computed for a real (stored) flow graph: for
    // legacy/linear campaigns current_node_id is null and the linear funnel serves.
    let flowProgress: FlowProgressData | null = null;
    let abStats: AbNodeStats[] = [];
    if (isFlowCampaign) {
      const [progEnrRes, progReplyRes] = await Promise.all([
        admin
          .from("campaign_enrollments")
          .select("current_node_id, current_step_index, status, contacts(email)")
          .eq("campaign_id", campaignId),
        admin
          .from("lead_replies")
          .select("lead_email, final_class, received_at")
          .eq("campaign_id", campaignId)
          // Excluded leads don't count toward stats. Match sync-analytics, which
          // already filters these, so the live flow-progress + A/B numbers agree
          // with the snapshot rollup instead of counting excluded replies.
          .eq("excluded_from_stats", false)
          .order("received_at", { ascending: false }),
      ]);
      const replyByEmail = new Map<string, ReplyClass | null>();
      for (const row of (progReplyRes.data ?? []) as {
        lead_email: string | null;
        final_class: ReplyClass | null;
      }[]) {
        const em = row.lead_email?.trim().toLowerCase();
        if (em && !replyByEmail.has(em)) replyByEmail.set(em, row.final_class ?? null);
      }
      const progEnrollments: ProgressEnrollment[] = (
        (progEnrRes.data ?? []) as {
          current_node_id: string | null;
          current_step_index: number | null;
          status: string;
          contacts: { email: string | null } | { email: string | null }[] | null;
        }[]
      ).map((e) => {
        const c = Array.isArray(e.contacts) ? e.contacts[0] : e.contacts;
        return {
          current_node_id: e.current_node_id,
          current_step_index: e.current_step_index,
          status: e.status,
          email: c?.email ?? null,
        };
      });
      flowProgress = computeFlowProgress(initialGraph, progEnrollments, replyByEmail);

      // A/B: per-variant reply stats, only when the graph actually tests a node.
      let hasAb = false;
      walkAll(initialGraph.nodes, (n) => {
        if (n.kind === "email" && isAbTest(n)) hasAb = true;
      });
      if (hasAb) {
        const { data: sendRows } = await admin
          .from("native_sends")
          .select("variant_id, to_email")
          .eq("campaign_id", campaignId)
          .not("variant_id", "is", null);
        abStats = computeVariantStats(
          initialGraph,
          (sendRows ?? []) as { variant_id: string | null; to_email: string | null }[],
          replyByEmail,
          campaign.ab_auto_pause_default ?? false,
        );
      }
    }

    // Setup tab: the full org mailbox pool + which ones are attached, so the
    // owner can add/remove inboxes at any time. Contacts-tab badge keys off the
    // launch-readiness contacts warning (enrollment count === 0). `usage` marks
    // inboxes claimed by ANOTHER non-completed campaign (dedicated-inbox policy).
    const [allMailboxesRes, attachedRes, usage] = await Promise.all([
      admin
        .from("native_mailboxes")
        .select("id, email_address, status, tags")
        .eq("organization_id", campaign.organization_id)
        .order("email_address", { ascending: true }),
      admin
        .from("campaign_mailboxes")
        .select("mailbox_id")
        .eq("campaign_id", campaign.id),
      mailboxUsageMap(admin, campaign.organization_id, campaign.id),
    ]);
    const allMailboxes = (
      (allMailboxesRes.data ?? []) as {
        id: string;
        email_address: string;
        status: string;
        tags: string[];
      }[]
    ).map((m) => {
      const owner = usage.get(m.id);
      return { ...m, inUse: !!owner, inUseBy: owner?.campaignName ?? null };
    });
    const attachedMailboxIds = (
      (attachedRes.data ?? []) as { mailbox_id: string }[]
    ).map((r) => r.mailbox_id);
    const contactsMissing = (launchReadiness?.warnings ?? []).some(
      (w) => w.key === "contacts",
    );

    return (
      <CampaignDetailWorkspace
        campaignId={campaign.id}
        campaignName={campaign.name}
        status={campaign.status}
        sourceChannel={campaign.source_channel}
        client={client}
        clients={orgClients}
        allMailboxes={allMailboxes}
        attachedMailboxIds={attachedMailboxIds}
        initialMailboxTag={campaign.mailbox_tag}
        contactsMissing={contactsMissing}
        initialGraph={initialGraph}
        initialWindow={sendWindow}
        initialNewLeadsCap={resolveDailyNewLeadsCap(campaign)}
        initialStrategy={sendingStrategy}
        initialAbAutoPauseDefault={campaign.ab_auto_pause_default ?? false}
        nativeStats={{
          sent: nativeStats.sent,
          replied: nativeStats.replied,
          bounced: nativeStats.bounced,
          enrollments: nativeStats.enrollments,
          verification: nativeStats.verification,
          mailboxes: nativeStats.mailboxes,
          dailyInboxCapacity: nativeStats.dailyInboxCapacity,
          activeMailboxCount: nativeStats.activeMailboxCount,
        }}
        flowProgress={flowProgress}
        abStats={abStats}
        stageRows={stageRows}
        projection={projection}
        strategyLabel={strategyLabel}
        contacts={campaignContacts}
        contactsTruncated={contactsTruncated}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <PageHeader
          backHref="/admin/campaigns"
          backLabel="Back to campaigns"
          title={campaign.name}
          actions={
            <>
              <Badge
                variant="secondary"
                className={
                  campaign.status === "active"
                    ? "badge-green"
                    : campaign.status === "paused"
                      ? "badge-amber"
                      : "badge-slate"
                }
              >
                {campaign.status}
              </Badge>
              <CampaignLifecycleButton
                campaignId={campaign.id}
                campaignName={campaign.name}
                status={campaign.status}
                sourceChannel={campaign.source_channel}
                blockers={launchReadiness?.blockers ?? []}
              />
            </>
          }
        />
      </div>

      {campaign.status === "draft" && launchReadiness && (
        <LaunchReadinessCard readiness={launchReadiness} />
      )}

      {/* Native email: send/reply stats, enrollment progress, mailbox pool, sequence */}
      {nativeStats && (
        <>
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EA4335]">
                <Inbox size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Native email</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Sends directly from your Google inboxes, paced across the sending window (checked every 5 min).
                  Sending schedule: <span className="font-medium text-foreground">{sendSchedule}</span>.
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <QueueStat label="Sent" value={nativeStats.sent} color="text-[#2E37FE]" hint={null} />
                <QueueStat
                  label="Replied"
                  value={nativeStats.replied}
                  color="text-emerald-600"
                  hint={null}
                />
                <QueueStat
                  label="Bounced"
                  value={nativeStats.bounced}
                  color={nativeStats.bounced > 0 ? "text-red-600" : "text-muted-foreground"}
                  hint={null}
                />
              </div>
              {/* Email verification (Million Verifier). Risky = catch-all +
                  unknown (sent, flagged); Undeliverable = invalid + disposable +
                  errored (never sent); Unverified = not yet checked. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
                <QueueStat
                  label="Verified"
                  value={nativeStats.verification.verified}
                  color="text-emerald-600"
                  hint={null}
                />
                <QueueStat
                  label="Risky"
                  value={nativeStats.verification.risky}
                  color={nativeStats.verification.risky > 0 ? "text-amber-600" : "text-muted-foreground"}
                  hint={null}
                />
                <QueueStat
                  label="Undeliverable"
                  value={nativeStats.verification.undeliverable}
                  color={
                    nativeStats.verification.undeliverable > 0 ? "text-red-600" : "text-muted-foreground"
                  }
                  hint={null}
                />
                <QueueStat
                  label="Unverified"
                  value={nativeStats.verification.unverified}
                  color="text-muted-foreground"
                  hint={null}
                />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Active: <strong>{nativeStats.enrollments.active}</strong></span>
                <span>Completed: <strong>{nativeStats.enrollments.completed}</strong></span>
                <span>Replied: <strong>{nativeStats.enrollments.replied}</strong></span>
                <span>Failed: <strong className={nativeStats.enrollments.failed > 0 ? "text-red-600" : ""}>{nativeStats.enrollments.failed}</strong></span>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Sending mailboxes</p>
                {nativeStats.mailboxes.length === 0 ? (
                  <p className="text-xs text-amber-700">No mailboxes assigned to this campaign.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {nativeStats.mailboxes.map((mb) => (
                      <Badge
                        key={mb.email}
                        variant="secondary"
                        className={mb.status === "active" ? "badge-green" : mb.status === "error" ? "badge-red" : "badge-slate"}
                      >
                        {mb.email}
                      </Badge>
                    ))}
                  </div>
                )}
                {nativeStats.activeMailboxCount > 0 && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Combined sending capacity:{" "}
                    <span className="font-medium text-foreground">
                      ~{nativeStats.dailyInboxCapacity}/day
                    </span>{" "}
                    across {nativeStats.activeMailboxCount} active inbox
                    {nativeStats.activeMailboxCount === 1 ? "" : "es"} (warmup-aware),
                    ~{Math.round(nativeStats.dailyInboxCapacity / nativeStats.activeMailboxCount)}/day
                    per inbox on average.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {stageRows.length > 0 && projection && (
            <StageFlowCard
              stages={stageRows}
              terminal={{
                replied: nativeStats.enrollments.replied,
                completed: nativeStats.enrollments.completed,
                failed: nativeStats.enrollments.failed,
              }}
              totals={{
                active: nativeStats.enrollments.active,
                enrolled:
                  nativeStats.enrollments.active +
                  nativeStats.enrollments.completed +
                  nativeStats.enrollments.replied +
                  nativeStats.enrollments.failed,
                sent: nativeStats.sent,
              }}
              projection={projection}
              strategyLabel={strategyLabel}
            />
          )}

          <Card className="border-border/50 shadow-sm">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
                <Upload size={16} className="text-white" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-base">Import contacts</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Upload a CSV: contacts enroll immediately and the sender
                  works through them at the mailbox caps. Columns can map to
                  this campaign&apos;s own {"{{variables}}"} as well as the
                  standard contact fields.
                </p>
              </div>
            </CardHeader>
            <CardContent>
              <NativeImportPanel campaignId={campaign.id} />
            </CardContent>
          </Card>

          <NativeSequenceSection
            campaignId={campaign.id}
            initialSteps={nativeStats.steps}
            initialWindow={sendWindow}
            initialNewLeadsCap={resolveDailyNewLeadsCap(campaign)}
            initialStrategy={sendingStrategy}
          />

          <CampaignProbeCard campaignId={campaign.id} />
        </>
      )}

      {/* Everyone assigned to this campaign + whether they're actually in the
          sending sequence. Channel-agnostic: renders for native email and
          LinkedIn alike. */}
      <CampaignContactsCard
        campaignId={campaign.id}
        contacts={campaignContacts}
        truncated={contactsTruncated}
        canEnroll={
          campaign.source_channel === "native_email" ||
          campaign.source_channel === "linkedin"
        }
      />

      {/* Orphan: surface a client-linker so the owner can attach in one click */}
      {!campaign.client_id && orgClients.length > 0 && (
        <Card className="border-amber-200 bg-amber-50 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Link to a client</CardTitle>
            <p className="text-xs text-amber-800/80">
              Replies from this campaign will not trigger client notifications
              until it&apos;s linked.
            </p>
          </CardHeader>
          <CardContent>
            <LinkOrphanForm
              campaignId={campaign.id}
              clients={orgClients}
            />
          </CardContent>
        </Card>
      )}

      {/* KPIs + chart: snapshot metrics for non-native channels (LinkedIn).
          Native email has its own stats card above (no campaign_snapshots),
          so skip this empty section for it. */}
      {campaign.source_channel !== "native_email" && (
      <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard label="Emails Sent" value={metrics.emails_sent} unit="count" />
        <KPICard
          label="Reply Rate"
          value={metrics.reply_rate}
          unit="percent"
          kpiKey="reply_rate"
        />
        <KPICard
          label="Bounce Rate"
          value={metrics.bounce_rate}
          unit="percent"
          kpiKey="bounce_rate"
        />
        <KPICard
          label="Positive Responses"
          value={metrics.meetings_booked}
          unit="count"
        />
      </div>

      <DailyChart snapshots={snapshots} />

      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[15px] font-semibold text-[#0f172a]">
          Daily Breakdown
        </h2>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          {snapshots.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No data synced yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Replies</TableHead>
                  <TableHead className="text-right">Bounces</TableHead>
                  <TableHead className="text-right">Unsubs</TableHead>
                  <TableHead className="text-right">Positive</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.slice(0, 14).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-sm">{s.snapshot_date}</TableCell>
                    <TableCell className="text-right">{s.emails_sent}</TableCell>
                    <TableCell className="text-right">{s.replies}</TableCell>
                    <TableCell className="text-right">{s.bounces}</TableCell>
                    <TableCell className="text-right">{s.unsubscribes}</TableCell>
                    <TableCell className="text-right">{s.meetings_booked}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      </>
      )}
    </div>
  );
}

function QueueStat({
  label,
  value,
  color,
  hint,
}: {
  label: string;
  value: number;
  color: string;
  hint: string | null;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

interface NativeStats {
  sent: number;
  bounced: number;
  replied: number;
  enrollments: { active: number; completed: number; replied: number; failed: number };
  mailboxes: { email: string; status: string }[];
  steps: { subject: string; body: string; wait_days: number }[];
  // Active enrollments bucketed by current_step_index (the next step they'll
  // receive) and total sends logged per step: the stage-flow funnel data.
  waitingByStep: number[];
  sentByStep: number[];
  // Warmup-aware daily send capacity across the ACTIVE inbox pool (sum of each
  // inbox's current effective cap) + how many inboxes back it. This is the
  // first-touch rate under reach_first and the honest throughput ceiling.
  dailyInboxCapacity: number;
  activeMailboxCount: number;
  // Per-campaign email-verification picture (migration 00069), tallied from
  // each enrollment's contact. risky = catch_all + unknown; undeliverable =
  // invalid + disposable + error; unverified = not yet checked.
  verification: { verified: number; risky: number; undeliverable: number; unverified: number };
}

async function nativeStatsFor(
  admin: ReturnType<typeof createAdminClient>,
  campaignId: string,
): Promise<NativeStats> {
  // One row-fetch of this campaign's sends (step_index + status) replaces the
  // separate sent/bounced count queries AND the per-step count N+1 further
  // down: sent, bounced, and sent-per-step are all tallied from these rows.
  // native_sends is a narrow log; pulling two columns for one campaign is far
  // cheaper on this instance than a fan-out of count-only queries.
  const [campaignSendsRes, repliedRes, stepsRes, poolRes, enrRes] = await Promise.all([
    admin.from("native_sends").select("step_index, status").eq("campaign_id", campaignId),
    admin.from("lead_replies").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).eq("source_channel", "native_email").eq("excluded_from_stats", false),
    admin.from("campaign_steps").select("step_index, subject_template, body_template, wait_days").eq("campaign_id", campaignId).order("step_index", { ascending: true }),
    admin.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", campaignId),
    admin
      .from("campaign_enrollments")
      .select("status, current_step_index, contacts(email_verification_status)")
      .eq("campaign_id", campaignId),
  ]);

  const campaignSends = (campaignSendsRes.data ?? []) as {
    step_index: number | null;
    status: string | null;
  }[];
  const sentCount = campaignSends.length;
  const bouncedCount = campaignSends.filter((s) => s.status === "bounced").length;

  const stepRows = (stepsRes.data ?? []) as {
    step_index: number;
    subject_template: string | null;
    body_template: string | null;
    wait_days: number;
  }[];
  const nSteps = stepRows.length;

  // Enrollment status tallies + active-by-current-step buckets (the funnel).
  // current_step_index is the NEXT step a contact will receive, so an active
  // enrollment at index i is "waiting for step i+1".
  const enrollments = { active: 0, completed: 0, replied: 0, failed: 0 };
  const verification = { verified: 0, risky: 0, undeliverable: 0, unverified: 0 };
  const waitingByStep = new Array(nSteps).fill(0) as number[];
  for (const row of (enrRes.data ?? []) as {
    status: string;
    current_step_index: number | null;
    contacts:
      | { email_verification_status: string | null }
      | { email_verification_status: string | null }[]
      | null;
  }[]) {
    if (row.status in enrollments) {
      enrollments[row.status as keyof typeof enrollments]++;
    }
    if (row.status === "active" && nSteps > 0) {
      const idx = Math.min(Math.max(row.current_step_index ?? 0, 0), nSteps - 1);
      waitingByStep[idx]++;
    }
    // The embed is array-vs-object ambiguous for a to-one FK; normalize both.
    const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
    const vs = contact?.email_verification_status ?? null;
    if (vs === "ok") verification.verified++;
    else if (vs === "catch_all" || vs === "unknown") verification.risky++;
    else if (vs === "invalid" || vs === "disposable" || vs === "error") verification.undeliverable++;
    else verification.unverified++;
  }

  // Sends logged per step so far: tallied from the campaign sends already
  // fetched above (was one count query per step).
  const sentByStep = new Array(nSteps).fill(0) as number[];
  for (const s of campaignSends) {
    const i = s.step_index ?? -1;
    if (i >= 0 && i < nSteps) sentByStep[i]++;
  }

  // Resolve the mailbox pool with a second query rather than a PostgREST
  // embed (embed typing is array-vs-object ambiguous for a to-one FK). Also
  // sum each ACTIVE inbox's current effective cap (effectiveDailyCap over its
  // all-time send count) into the campaign's warmup-aware daily capacity: the
  // reach_first first-touch rate and the honest ceiling either way.
  const mailboxIds = ((poolRes.data ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id);
  let mailboxes: { email: string; status: string }[] = [];
  let dailyInboxCapacity = 0;
  let activeMailboxCount = 0;
  if (mailboxIds.length > 0) {
    const { data: mbData } = await admin
      .from("native_mailboxes")
      .select("id, email_address, status, max_daily_cap, daily_cap_override")
      .in("id", mailboxIds);
    const mbs = (mbData ?? []) as {
      id: string;
      email_address: string;
      status: string;
      max_daily_cap: number;
      daily_cap_override: number | null;
    }[];
    mailboxes = mbs.map((m) => ({ email: m.email_address, status: m.status }));
    const activeMbs = mbs.filter((m) => m.status === "active");
    activeMailboxCount = activeMbs.length;
    // Each active inbox's warmup cap keys off its all-time send count. One fetch
    // of mailbox_id for the active pool, tallied in JS, replaces the per-mailbox
    // count query (was one round-trip per active inbox).
    const sendCountByMailbox = new Map<string, number>();
    if (activeMbs.length > 0) {
      const { data: mbSendRows } = await admin
        .from("native_sends")
        .select("mailbox_id")
        .in(
          "mailbox_id",
          activeMbs.map((m) => m.id),
        );
      for (const row of (mbSendRows ?? []) as { mailbox_id: string | null }[]) {
        if (row.mailbox_id) {
          sendCountByMailbox.set(
            row.mailbox_id,
            (sendCountByMailbox.get(row.mailbox_id) ?? 0) + 1,
          );
        }
      }
    }
    dailyInboxCapacity = activeMbs.reduce(
      (sum, m) =>
        sum +
        effectiveDailyCap(
          { max_daily_cap: m.max_daily_cap, daily_cap_override: m.daily_cap_override },
          sendCountByMailbox.get(m.id) ?? 0,
        ),
      0,
    );
  }

  const steps = stepRows.map((s) => ({
    subject: s.subject_template ?? "",
    body: s.body_template ?? "",
    wait_days: s.wait_days,
  }));

  return {
    sent: sentCount,
    bounced: bouncedCount,
    replied: repliedRes.count ?? 0,
    enrollments,
    mailboxes,
    steps,
    waitingByStep,
    sentByStep,
    dailyInboxCapacity,
    activeMailboxCount,
    verification,
  };
}

// Inline client-linker for orphan campaigns. Tiny form, no full component
// POSTs to a one-shot route that updates campaigns.client_id.
function LinkOrphanForm({
  campaignId,
  clients,
}: {
  campaignId: string;
  clients: Pick<Client, "id" | "name">[];
}) {
  return (
    <form
      action={`/app/api/admin/campaigns/${campaignId}/link-client`}
      method="post"
      className="flex items-center gap-2"
    >
      <select
        name="client_id"
        defaultValue=""
        className="flex-1 rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
      >
        <option value="" disabled>
          Pick a client…
        </option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700"
      >
        <CheckCircle2 size={14} /> Link
      </button>
    </form>
  );
}
