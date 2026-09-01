"use client";
import { PageHeader } from "@/components/layout/page-header";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
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
import { Button } from "@/components/ui/button";
import { ContactSection } from "./contact-section";
import { ClientUsersSection } from "./client-users-section";
import { ReplyRoutingSection } from "./reply-routing-section";
import { LinkedinSection } from "./linkedin-section";
import { DncSection } from "./dnc-section";
import {
  ArrowLeft,
  ArrowRight,
  Mail,
  MessageSquare,
  Calendar,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import type {
  Client,
  Campaign,
  CampaignSnapshot,
  LeadFeedback,
  ClientStatus,
} from "@/types/app";

export interface LinkedClientUser {
  user_id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  invite_status: string;
}

type Period = "7d" | "30d" | "lifetime";

function filterByPeriod(
  snapshots: CampaignSnapshot[],
  period: Period,
): CampaignSnapshot[] {
  if (period === "lifetime") return snapshots;
  const days = period === "7d" ? 7 : 30;
  const cutoff = new Date(Date.now() - days * 86400000)
    .toISOString()
    .split("T")[0];
  return snapshots.filter((s) => s.snapshot_date >= cutoff);
}

export function ClientDetailClient({
  clientId,
  client,
  campaigns,
  feedback,
  allSnapshots,
  linkedUsers,
}: {
  clientId: string;
  client: Client;
  campaigns: Campaign[];
  feedback: LeadFeedback[];
  allSnapshots: CampaignSnapshot[];
  linkedUsers: LinkedClientUser[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Default to lifetime (All-Time) — a rolling 30-day reply rate understates it
  // (fresh, unreplied leads dilute the denominator). 7d/30d stay one click away.
  const [period, setPeriod] = useState<Period>("lifetime");
  const [statusUpdating, setStatusUpdating] = useState(false);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function toggleClientStatus(current: ClientStatus) {
    const next: ClientStatus = current === "active" ? "former" : "active";
    setStatusUpdating(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("clients")
      .update({ status: next })
      .eq("id", clientId);
    setStatusUpdating(false);
    if (error) {
      alert(`Could not update client: ${error.message}`);
      return;
    }
    refresh();
  }

  const periodSnapshots = filterByPeriod(allSnapshots, period);
  const periodMetrics = calculateMetrics(periodSnapshots);
  const lifetimeMetrics = calculateMetrics(allSnapshots);

  const periodLabel =
    period === "7d"
      ? "Last 7 Days"
      : period === "30d"
        ? "Last 30 Days"
        : "Lifetime";

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back to Overview
        </Link>
        <PageHeader
          className="mt-3"
          title={
            <span className="inline-flex items-center gap-2">
              {client.name}
              <Badge
                variant="secondary"
                className={
                  (client.status ?? "active") === "active"
                    ? "badge-green"
                    : "badge-amber"
                }
              >
                {(client.status ?? "active") === "active" ? "Active" : "Former"}
              </Badge>
            </span>
          }
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={statusUpdating}
              onClick={() =>
                toggleClientStatus((client.status ?? "active") as ClientStatus)
              }
              className="gap-1.5"
            >
              {(client.status ?? "active") === "active" ? (
                <>
                  <Archive size={14} /> Archive Client
                </>
              ) : (
                <>
                  <ArchiveRestore size={14} /> Restore to Active
                </>
              )}
            </Button>
          }
        />
      </div>

      <ContactSection client={client} onSaved={refresh} />

      <ClientUsersSection
        clientId={clientId}
        users={linkedUsers}
        reportRecipients={client.report_recipients}
        onUsersChanged={refresh}
      />

      <ReplyRoutingSection client={client} onSaved={refresh} />

      <DncSection clientId={clientId} clientName={client.name} />

      <LinkedinSection client={client} onChanged={refresh} />

      <div className="flex items-center gap-2">
        <Calendar size={14} className="text-muted-foreground" />
        {(["7d", "30d", "lifetime"] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              period === p
                ? "bg-[#2E37FE]/20 text-[#6B72FF] border border-[#2E37FE]/20"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
          >
            {p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : "Lifetime"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label={`Emails Sent (${periodLabel})`}
          value={periodMetrics.emails_sent}
          unit="count"
          subtitle={
            period !== "lifetime"
              ? `${lifetimeMetrics.emails_sent.toLocaleString()} lifetime`
              : undefined
          }
        />
        <KPICard
          label="Reply Rate"
          value={periodMetrics.reply_rate}
          unit="percent"
          kpiKey="reply_rate"
          subtitle={
            period !== "lifetime"
              ? `${lifetimeMetrics.reply_rate}% lifetime`
              : undefined
          }
        />
        <KPICard
          label="Bounce Rate"
          value={periodMetrics.bounce_rate}
          unit="percent"
          kpiKey="bounce_rate"
          subtitle={
            period !== "lifetime"
              ? `${lifetimeMetrics.bounce_rate}% lifetime`
              : undefined
          }
        />
        <KPICard
          label="Positive Responses"
          value={periodMetrics.meetings_booked}
          unit="count"
          kpiKey="meetings_booked"
          subtitle={
            period !== "lifetime"
              ? `${lifetimeMetrics.meetings_booked} lifetime`
              : undefined
          }
        />
      </div>

      {periodSnapshots.length > 0 && (
        <DailyChart
          snapshots={periodSnapshots}
          title={`${client.name} — ${periodLabel}`}
        />
      )}

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Mail size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">
            Campaigns ({campaigns.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No campaigns mapped yet.
            </p>
          ) : (
            <div className="space-y-3">
              {campaigns.map((campaign) => {
                const campAllSnapshots = allSnapshots.filter(
                  (s) => s.campaign_id === campaign.id,
                );
                const campPeriodSnapshots = filterByPeriod(
                  campAllSnapshots,
                  period,
                );
                const campPeriodMetrics = calculateMetrics(campPeriodSnapshots);
                const campLifetimeMetrics = calculateMetrics(campAllSnapshots);

                return (
                  <Link
                    key={campaign.id}
                    href={`/admin/clients/${clientId}/campaigns/${campaign.id}`}
                    className="group block rounded-xl border border-border/50 p-4 transition-all hover:border-[#2E37FE]/20 hover:shadow-md"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0"
                          style={{ background: "#2E37FE" }}
                        >
                          <Mail size={14} />
                        </div>
                        <div>
                          <p className="font-medium text-foreground">
                            {campaign.name}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
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
                        <ArrowRight
                          size={14}
                          className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                        />
                      </div>
                    </div>

                    {campPeriodMetrics.emails_sent > 0 ||
                    campLifetimeMetrics.emails_sent > 0 ? (
                      <div className="space-y-2 pt-3 border-t border-border/30">
                        <div className="grid grid-cols-4 gap-4">
                          <div>
                            <p className="text-sm font-bold">
                              {campPeriodMetrics.emails_sent.toLocaleString()}
                            </p>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                              Sent
                            </p>
                          </div>
                          <div>
                            <p
                              className={`text-sm font-bold ${
                                campPeriodMetrics.reply_rate >= 5
                                  ? "text-emerald-700"
                                  : campPeriodMetrics.reply_rate >= 2
                                    ? "text-amber-700"
                                    : "text-red-700"
                              }`}
                            >
                              {campPeriodMetrics.reply_rate}%
                            </p>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                              Reply
                            </p>
                          </div>
                          <div>
                            <p
                              className={`text-sm font-bold ${
                                campPeriodMetrics.bounce_rate <= 2
                                  ? "text-emerald-700"
                                  : campPeriodMetrics.bounce_rate <= 5
                                    ? "text-amber-700"
                                    : "text-red-700"
                              }`}
                            >
                              {campPeriodMetrics.bounce_rate}%
                            </p>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                              Bounce
                            </p>
                          </div>
                          <div>
                            <p className="text-sm font-bold">
                              {campPeriodMetrics.meetings_booked}
                            </p>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                              Positive
                            </p>
                          </div>
                        </div>
                        {period !== "lifetime" &&
                          campLifetimeMetrics.emails_sent > 0 && (
                            <div className="grid grid-cols-4 gap-4 text-muted-foreground">
                              <div>
                                <p className="text-xs">
                                  {campLifetimeMetrics.emails_sent.toLocaleString()}
                                </p>
                                <p className="text-[9px] uppercase tracking-wide">
                                  Lifetime
                                </p>
                              </div>
                              <div>
                                <p className="text-xs">
                                  {campLifetimeMetrics.reply_rate}%
                                </p>
                                <p className="text-[9px] uppercase tracking-wide">
                                  Lifetime
                                </p>
                              </div>
                              <div>
                                <p className="text-xs">
                                  {campLifetimeMetrics.bounce_rate}%
                                </p>
                                <p className="text-[9px] uppercase tracking-wide">
                                  Lifetime
                                </p>
                              </div>
                              <div>
                                <p className="text-xs">
                                  {campLifetimeMetrics.meetings_booked}
                                </p>
                                <p className="text-[9px] uppercase tracking-wide">
                                  Lifetime
                                </p>
                              </div>
                            </div>
                          )}
                      </div>
                    ) : (
                      <div className="pt-3 border-t border-border/30">
                        <p className="text-xs text-muted-foreground">
                          No data yet
                        </p>
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <MessageSquare size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Recent Feedback</CardTitle>
        </CardHeader>
        <CardContent>
          {feedback.length === 0 ? (
            <p className="text-sm text-muted-foreground">No feedback yet.</p>
          ) : (
            <div className="space-y-2">
              {feedback.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-3 rounded-xl border border-border/50 p-3 text-sm transition-colors hover:bg-muted/30"
                >
                  <Badge
                    variant="secondary"
                    className={
                      ["good_lead", "interested"].includes(f.status)
                        ? "badge-green"
                        : ["bad_lead", "wrong_person", "not_interested"].includes(
                              f.status,
                            )
                          ? "badge-red"
                          : "badge-slate"
                    }
                  >
                    {f.status.replace(/_/g, " ")}
                  </Badge>
                  <span className="font-medium">{f.lead_email}</span>
                  {f.comment && (
                    <span className="text-muted-foreground truncate">
                      {f.comment}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(f.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
