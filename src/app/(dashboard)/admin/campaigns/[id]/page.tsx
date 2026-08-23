// Top-level campaign detail page. Orphan-safe (works regardless of
// client_id). For native_email campaigns this renders send/reply stats, the
// mailbox pool, an inline CSV import panel, and the sequence editor. Per-client
// detail at /admin/clients/[clientId]/campaigns/[campaignId] is the older view
// — this one is what list rows link to from /admin/campaigns.

import Link from "next/link";
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
import { ArrowLeft, Inbox, Upload, AlertCircle, CheckCircle2 } from "lucide-react";
import { NativeImportPanel } from "@/components/campaigns/native-import-panel";
import { NativeSequenceSection } from "./native-sequence-section";
import { StageFlowCard, type StageRow } from "./stage-flow-card";
import { CampaignLifecycleButton } from "./campaign-lifecycle-button";
import type { Campaign, CampaignSnapshot, Client } from "@/types/app";

const SNAPSHOT_COLUMNS =
  "id, campaign_id, snapshot_date, total_leads, emails_sent, replies, " +
  "unique_replies, positive_replies, bounces, unsubscribes, meetings_booked, " +
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

  const [clientRes, snapshotsRes, clientsForLinkRes] =
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
      // For orphan campaigns, surface the list of clients in the org
      // so the owner can link the campaign in one click.
      campaign.client_id
        ? Promise.resolve({ data: null })
        : supabase
            .from("clients")
            .select("id, name")
            .eq("organization_id", campaign.organization_id)
            .order("name"),
    ]);

  const client = clientRes.data as { id: string; name: string } | null;
  const snapshots = (snapshotsRes.data ?? []) as unknown as CampaignSnapshot[];
  const clientsForLink = (clientsForLinkRes.data ?? []) as Pick<
    Client,
    "id" | "name"
  >[];

  const metrics = calculateMetrics(snapshots, "lifetime");

  // Native email campaigns pull their stats straight from
  // native_sends / lead_replies / campaign_enrollments.
  const nativeStats =
    campaign.source_channel === "native_email"
      ? await nativeStatsFor(admin, campaignId)
      : null;

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

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/campaigns"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back to campaigns
        </Link>
        <PageHeader
          className="mt-3"
          eyebrow={campaign.source_channel}
          title={campaign.name}
          subtitle={
            client ? (
              <>
                Linked to{" "}
                <Link href={`/admin/clients/${client.id}`} className="underline">
                  {client.name}
                </Link>
              </>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-700">
                <AlertCircle size={14} /> Orphan campaign — not linked to a
                LeadStart client
              </span>
            )
          }
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
              />
            </>
          }
        />
      </div>

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
              <div className="grid grid-cols-4 gap-4">
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
                    {nativeStats.activeMailboxCount === 1 ? "" : "es"} (warmup-aware) —
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
                  Upload a CSV — contacts enroll immediately and the sender
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
        </>
      )}

      {/* Orphan: surface a client-linker so the owner can attach in one click */}
      {!campaign.client_id && clientsForLink.length > 0 && (
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
              clients={clientsForLink}
            />
          </CardContent>
        </Card>
      )}

      {/* KPIs + chart — snapshot metrics for non-native channels (LinkedIn).
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
  // receive) and total sends logged per step — the stage-flow funnel data.
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
  const [sentRes, bouncedRes, repliedRes, stepsRes, poolRes, enrRes] = await Promise.all([
    admin.from("native_sends").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId),
    admin.from("native_sends").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).eq("status", "bounced"),
    admin.from("lead_replies").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).eq("source_channel", "native_email"),
    admin.from("campaign_steps").select("step_index, subject_template, body_template, wait_days").eq("campaign_id", campaignId).order("step_index", { ascending: true }),
    admin.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", campaignId),
    admin
      .from("campaign_enrollments")
      .select("status, current_step_index, contacts(email_verification_status)")
      .eq("campaign_id", campaignId),
  ]);

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

  // Sends logged per step so far — one bounded head-count per step (steps are
  // few, so this is a handful of count-only queries, no rows transferred).
  const sentByStep =
    nSteps > 0
      ? await Promise.all(
          stepRows.map((_, i) =>
            admin
              .from("native_sends")
              .select("id", { count: "exact", head: true })
              .eq("campaign_id", campaignId)
              .eq("step_index", i)
              .then((r) => r.count ?? 0),
          ),
        )
      : [];

  // Resolve the mailbox pool with a second query rather than a PostgREST
  // embed (embed typing is array-vs-object ambiguous for a to-one FK). Also
  // sum each ACTIVE inbox's current effective cap (effectiveDailyCap over its
  // all-time send count) into the campaign's warmup-aware daily capacity — the
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
    const caps = await Promise.all(
      activeMbs.map(async (m) => {
        const { count } = await admin
          .from("native_sends")
          .select("id", { count: "exact", head: true })
          .eq("mailbox_id", m.id);
        return effectiveDailyCap(
          { max_daily_cap: m.max_daily_cap, daily_cap_override: m.daily_cap_override },
          count ?? 0,
        );
      }),
    );
    dailyInboxCapacity = caps.reduce((a, b) => a + b, 0);
  }

  const steps = stepRows.map((s) => ({
    subject: s.subject_template ?? "",
    body: s.body_template ?? "",
    wait_days: s.wait_days,
  }));

  return {
    sent: sentRes.count ?? 0,
    bounced: bouncedRes.count ?? 0,
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
// — POSTs to a one-shot route that updates campaigns.client_id.
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
