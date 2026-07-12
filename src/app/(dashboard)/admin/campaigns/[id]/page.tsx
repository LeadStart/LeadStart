// Top-level campaign detail page. Orphan-safe (works regardless of
// client_id). For source_channel='salesforge' campaigns this renders the
// queue state + an inline CSV import panel feeding the throttled
// enrollment queue. Per-client detail at
// /admin/clients/[clientId]/campaigns/[campaignId] is the older view —
// this one is what list rows link to from /admin/campaigns.

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { KPICard } from "@/components/charts/kpi-card";
import { DailyChart } from "@/components/charts/daily-chart";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { resolveSendWindow, formatSendWindow } from "@/lib/gmail/ramp";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowLeft, Inbox, Upload, AlertCircle, CheckCircle2 } from "lucide-react";
import { CampaignImportPanel } from "./import-panel";
import { NativeImportPanel } from "@/components/campaigns/native-import-panel";
import { NativeSequenceCard } from "./native-sequence-card";
import { CampaignLifecycleButton } from "./campaign-lifecycle-button";
import { DeliverabilityCard } from "./deliverability-card";
import { CampaignContactsTable } from "./contacts-table";
import { PacingEditor } from "./pacing-editor";
import { TagsEditor } from "./tags-editor";
import { CustomVarMapping } from "./custom-var-mapping";
import { PurgeQueuedButton } from "./purge-queued-button";
import type { Campaign, CampaignSnapshot, Client } from "@/types/app";

const DEFAULT_DAILY_CAP = 66;

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
  // The queue-state counts go through the admin client because the
  // client-scoped supabase respects RLS that would hide queue rows from
  // the owner if any policy is misconfigured. Admin client is fine here
  // since the page is already owner-gated by the dashboard layout.
  const admin = createAdminClient();

  const [clientRes, snapshotsRes, clientsForLinkRes, queueCountsRes] =
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
      campaign.source_channel === "salesforge"
        ? queueCountsFor(admin, campaignId)
        : Promise.resolve({
            pending: 0,
            sent_today: 0,
            failed: 0,
          }),
    ]);

  const client = clientRes.data as { id: string; name: string } | null;
  const snapshots = (snapshotsRes.data ?? []) as unknown as CampaignSnapshot[];
  const clientsForLink = (clientsForLinkRes.data ?? []) as Pick<
    Client,
    "id" | "name"
  >[];
  const queue = queueCountsRes as {
    pending: number;
    sent_today: number;
    failed: number;
  };

  const metrics = calculateMetrics(snapshots, "lifetime");
  const cap = campaign.salesforge_daily_contact_cap ?? DEFAULT_DAILY_CAP;
  const drainDays = cap > 0 ? Math.ceil(queue.pending / cap) : null;

  // Native email campaigns don't have Salesforge snapshots — pull their
  // stats straight from native_sends / lead_replies / campaign_enrollments.
  const nativeStats =
    campaign.source_channel === "native_email"
      ? await nativeStatsFor(admin, campaignId)
      : null;

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
        <div
          className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a] mt-3"
          style={{
            background:
              "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
            border: "1px solid rgba(46,55,254,0.2)",
            borderTop: "1px solid rgba(46,55,254,0.3)",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
          }}
        >
          <div className="relative z-10 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#64748b] uppercase tracking-wide">
                {campaign.source_channel}
              </p>
              <h1 className="text-2xl font-bold mt-1">{campaign.name}</h1>
              {campaign.salesforge_sequence_id && (
                <p className="text-xs text-[#0f172a]/50 font-mono mt-1">
                  Sequence {campaign.salesforge_sequence_id}
                </p>
              )}
              {client ? (
                <p className="text-sm text-[#0f172a]/70 mt-2">
                  Linked to{" "}
                  <Link
                    href={`/admin/clients/${client.id}`}
                    className="underline"
                  >
                    {client.name}
                  </Link>
                </p>
              ) : (
                <p className="text-sm text-amber-700 mt-2 inline-flex items-center gap-1">
                  <AlertCircle size={14} /> Orphan campaign — not linked to a
                  LeadStart client
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              <Badge
                className={
                  campaign.status === "active"
                    ? "bg-emerald-500/20 text-emerald-900 border-0"
                    : campaign.status === "paused"
                      ? "bg-amber-500/20 text-amber-900 border-0"
                      : "bg-white/40 text-[#0f172a]/70 border-0"
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
            </div>
          </div>
          <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
        </div>
      </div>

      {/* Salesforge-specific: enrollment queue state + import panel */}
      {campaign.source_channel === "salesforge" && (
        <>
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="flex flex-row items-start gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
                <Inbox size={16} className="text-white" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-base">Enrollment queue</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1.5 flex-wrap">
                  <span>
                    Cron drains pending rows daily at 12:00 UTC ≈ 5am Pacific at{" "}
                    <strong>{cap}/day</strong>
                    {campaign.salesforge_daily_contact_cap == null && (
                      <> (default)</>
                    )}
                    {" — "}
                  </span>
                  <PacingEditor
                    campaignId={campaign.id}
                    currentCap={campaign.salesforge_daily_contact_cap}
                  />
                </p>
                <p className="text-xs text-muted-foreground mt-1 inline-flex items-center gap-1.5 flex-wrap">
                  <span>
                    Salesforge tags pushed with each contact:{" "}
                    <strong>
                      {campaign.salesforge_default_tags &&
                      campaign.salesforge_default_tags.length > 0
                        ? campaign.salesforge_default_tags.join(", ")
                        : "leadstart (default)"}
                    </strong>
                    {" — "}
                  </span>
                  <TagsEditor
                    campaignId={campaign.id}
                    currentTags={campaign.salesforge_default_tags}
                  />
                </p>
              </div>
              {queue.pending > 0 && (
                <PurgeQueuedButton
                  campaignId={campaign.id}
                  pendingCount={queue.pending}
                />
              )}
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <QueueStat
                  label="Pending"
                  value={queue.pending}
                  color="text-[#2E37FE]"
                  hint={
                    queue.pending > 0 && drainDays
                      ? `~${drainDays} day${drainDays === 1 ? "" : "s"} to drain`
                      : null
                  }
                />
                <QueueStat
                  label="Sent today"
                  value={queue.sent_today}
                  color="text-emerald-600"
                  hint={`cap: ${cap}/day`}
                />
                <QueueStat
                  label="Failed"
                  value={queue.failed}
                  color={queue.failed > 0 ? "text-red-600" : "text-muted-foreground"}
                  hint={queue.failed > 0 ? "check the queue table" : null}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50 shadow-sm">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
                <Upload size={16} className="text-white" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-base">Import contacts</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Upload a CSV — contacts land in the queue and enroll at the
                  daily cap above. Required column: <code>email</code>. Optional:
                  first_name, last_name, company, title, phone, linkedin_url,
                  tags, notes.
                </p>
              </div>
            </CardHeader>
            <CardContent>
              <CampaignImportPanel
                campaignId={campaign.id}
                campaignName={campaign.name}
                organizationId={campaign.organization_id}
                clientId={campaign.client_id}
                savedMapping={campaign.csv_column_mapping ?? null}
              />
            </CardContent>
          </Card>

          <CustomVarMapping
            campaignId={campaign.id}
            currentMapping={campaign.salesforge_custom_var_mapping}
          />

          <CampaignContactsTable campaignId={campaign.id} />
        </>
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
                  Sends directly from your Google inboxes, checked every 15 min.
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
              </div>
            </CardContent>
          </Card>

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

          <NativeSequenceCard
            campaignId={campaign.id}
            initialSteps={nativeStats.steps}
            initialWindow={sendWindow}
          />

          <DeliverabilityCard campaignId={campaign.id} />
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

      {/* KPIs + chart — Salesforge/LinkedIn snapshot metrics. Native email
          has its own stats card above (no campaign_snapshots), so skip this
          empty section for it. */}
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
              No data synced yet. Salesforge analytics populate once the
              sequence has status=&quot;active&quot; (the hourly sync only
              pulls active sequences).
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

async function queueCountsFor(
  admin: ReturnType<typeof createAdminClient>,
  campaignId: string,
): Promise<{ pending: number; sent_today: number; failed: number }> {
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const startIso = startOfDayUtc.toISOString();

  const [pending, sentToday, failed] = await Promise.all([
    admin
      .from("salesforge_enrollment_queue")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "pending"),
    admin
      .from("salesforge_enrollment_queue")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "sent")
      .gte("processed_at", startIso),
    admin
      .from("salesforge_enrollment_queue")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "failed"),
  ]);

  return {
    pending: pending.count ?? 0,
    sent_today: sentToday.count ?? 0,
    failed: failed.count ?? 0,
  };
}

interface NativeStats {
  sent: number;
  bounced: number;
  replied: number;
  enrollments: { active: number; completed: number; replied: number; failed: number };
  mailboxes: { email: string; status: string }[];
  steps: { subject: string; body: string; wait_days: number }[];
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
    admin.from("campaign_enrollments").select("status").eq("campaign_id", campaignId),
  ]);

  const enrollments = { active: 0, completed: 0, replied: 0, failed: 0 };
  for (const row of (enrRes.data ?? []) as { status: string }[]) {
    if (row.status in enrollments) {
      enrollments[row.status as keyof typeof enrollments]++;
    }
  }

  // Resolve the mailbox pool with a second query rather than a PostgREST
  // embed (embed typing is array-vs-object ambiguous for a to-one FK).
  const mailboxIds = ((poolRes.data ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id);
  let mailboxes: { email: string; status: string }[] = [];
  if (mailboxIds.length > 0) {
    const { data: mbData } = await admin
      .from("native_mailboxes")
      .select("email_address, status")
      .in("id", mailboxIds);
    mailboxes = ((mbData ?? []) as { email_address: string; status: string }[]).map((m) => ({
      email: m.email_address,
      status: m.status,
    }));
  }

  const steps = ((stepsRes.data ?? []) as { subject_template: string | null; body_template: string | null; wait_days: number }[]).map((s) => ({
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
