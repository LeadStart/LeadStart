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
import { CampaignContactsTable } from "./contacts-table";
import { PacingEditor } from "./pacing-editor";
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
          </div>
          <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
        </div>
      </div>

      {/* Salesforge-specific: enrollment queue state + import panel */}
      {campaign.source_channel === "salesforge" && (
        <>
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
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
              </div>
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
              />
            </CardContent>
          </Card>

          <CampaignContactsTable
            campaignId={campaign.id}
            campaignStatus={campaign.status}
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

      {/* KPIs + chart — empty for new draft campaigns, populates as
          sync-analytics pulls snapshots */}
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
