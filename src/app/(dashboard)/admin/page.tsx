"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  ADMIN_OVERVIEW_KEY,
  API_BILLING_DATA_PATH,
  API_INBOX_HEALTH_PATH,
  fetchAdminOverview,
  type AdminOverviewCard,
} from "@/lib/admin-queries";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import Link from "next/link";
import {
  ArrowRight,
  AlertTriangle,
  AlertCircle,
  Clock,
  CreditCard,
  TrendingDown,
  Users,
  MessageSquare,
  Activity,
  Inbox,
  DollarSign,
  Send,
  CheckCircle2,
} from "lucide-react";
import type {
  ClientSubscription,
  PricingPlan,
  Client,
  BillingInvoice,
  Quote,
} from "@/types/app";

// ---------- Threshold ----------
// Matches the "Good" cutoff used on the inbox-health detail page so the
// dashboard signal and the detail page stay in sync. Changing this in one
// place would create two competing definitions of "unhealthy" — keep them
// aligned (or bump both together).
const INBOX_HEALTH_THRESHOLD = 80;

// ---------- API response shapes (cached endpoints) ----------
interface InboxHealthInbox {
  email: string;
  domain: string;
  healthScore: number | null;
  sent30d: number;
}
interface InboxHealthResponse {
  inboxes: InboxHealthInbox[];
  domains: { domain: string; inboxCount: number; avgHealthScore: number | null }[];
  summary: {
    totalInboxes: number;
    activeInboxes: number;
    avgHealthScore: number | null;
  };
}

interface BillingDataResponse {
  plans: PricingPlan[];
  quotes: Quote[];
  subscriptions: ClientSubscription[];
  invoices: BillingInvoice[];
  clients: Client[];
  stripe_mode: "demo" | "live" | "test";
}

// ---------- Helpers ----------
function formatCents(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString()}`
    : `$${dollars.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

// ---------- Sub-components ----------
function HealthDot({
  health,
}: {
  health: "good" | "warning" | "bad" | "none";
}) {
  const colors = {
    good: "bg-emerald-500",
    warning: "bg-amber-500",
    bad: "bg-red-500",
    none: "bg-gray-300",
  };
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${colors[health]}`} />
  );
}

function MiniStat({
  label,
  value,
  health,
}: {
  label: string;
  value: string;
  health?: "good" | "warning" | "bad";
}) {
  const textColor =
    health === "good"
      ? "text-emerald-600"
      : health === "warning"
        ? "text-amber-600"
        : health === "bad"
          ? "text-red-600"
          : "text-foreground";
  return (
    <div className="text-center">
      <p className={`text-sm font-bold ${textColor}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
    </div>
  );
}

function getHealthLabel(health: "good" | "warning" | "bad" | "none") {
  return {
    good: { text: "Healthy", class: "badge-green" },
    warning: { text: "Step Drop", class: "badge-amber" },
    bad: { text: "At Risk", class: "badge-red" },
    none: { text: "No Data", class: "badge-slate" },
  }[health];
}

function ClientCard({ card }: { card: AdminOverviewCard }) {
  const { client, activeCampaigns, clientCampaigns, metrics, health } = card;
  const healthLabel = getHealthLabel(health);
  return (
    <Link href={`/admin/clients/${client.id}`} className="group block">
      <Card className="border-border/50 shadow-sm transition-all duration-200 hover:border-[#2E37FE]/20 hover:shadow-md h-full">
        <CardContent className="pt-5 pb-4 px-5">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0"
                style={{ background: "#2E37FE" }}
              >
                {client.name.charAt(0)}
              </div>
              <div>
                <p className="font-semibold text-foreground">{client.name}</p>
                <p className="text-xs text-muted-foreground">
                  {activeCampaigns.length} active / {clientCampaigns.length} total
                </p>
              </div>
            </div>
            <ArrowRight
              size={16}
              className="text-muted-foreground mt-1 opacity-0 transition-all group-hover:opacity-100 group-hover:translate-x-0.5"
            />
          </div>
          <div className="mb-4">
            <Badge
              variant="secondary"
              className={`text-xs border ${healthLabel.class}`}
            >
              <HealthDot health={health} />
              <span className="ml-1.5">{healthLabel.text}</span>
            </Badge>
          </div>
          {metrics.emails_sent > 0 ? (
            <div className="grid grid-cols-4 gap-2 pt-3 border-t border-border/50">
              <MiniStat
                label="Sent"
                value={metrics.emails_sent.toLocaleString()}
              />
              <MiniStat
                label="Reply"
                value={`${metrics.reply_rate}%`}
                health={
                  metrics.reply_rate >= 10
                    ? "good"
                    : metrics.reply_rate >= 5
                      ? "warning"
                      : "bad"
                }
              />
              <MiniStat
                label="Bounce"
                value={`${metrics.bounce_rate}%`}
                health={
                  metrics.bounce_rate <= 2
                    ? "good"
                    : metrics.bounce_rate <= 5
                      ? "warning"
                      : "bad"
                }
              />
              <MiniStat
                label="Positive"
                value={String(metrics.meetings_booked)}
              />
            </div>
          ) : (
            <div className="pt-3 border-t border-border/50">
              <p className="text-xs text-muted-foreground text-center py-2">
                No campaign data yet
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function SectionHeading({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
        {icon}
      </div>
      <div>
        <h2 className="text-[15px] font-semibold text-[#0f172a] leading-tight">
          {title}
        </h2>
        {subtitle && (
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        )}
      </div>
    </div>
  );
}

// ---------- Page ----------
export default function AdminOverviewPage() {
  const { data: overview, loading: ovLoading } = useSupabaseQuery(
    ADMIN_OVERVIEW_KEY,
    fetchAdminOverview,
  );
  // Both endpoints are pre-warmed by AdminPrefetcher — these calls share that
  // cache instead of triggering a second round-trip to Instantly / Supabase.
  const { data: billing } = useApiQuery<BillingDataResponse>(
    API_BILLING_DATA_PATH,
  );
  const { data: inbox } = useApiQuery<InboxHealthResponse>(
    API_INBOX_HEALTH_PATH,
  );

  // Capture once per page instance so date comparisons during render are
  // referentially stable (and don't trip the react-hooks/purity rule). The
  // dashboard isn't a real-time clock — if the owner leaves the tab open
  // for hours, the SWR cache lags too. They refresh by navigating.
  // Must sit above the loading return so hook order is stable.
  const [now] = useState<number>(() => Date.now());
  const sevenDaysFromNow = now + 7 * 86400000;

  if (ovLoading || !overview) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-36 bg-muted/50" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl h-24 bg-muted/50" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl h-64 bg-muted/50" />
          <div className="rounded-xl h-64 bg-muted/50" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl h-44 bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  const clientCards = overview.cards;
  const totalActive = overview.totalActive;
  const totalClients = clientCards.length;
  const healthyCt = clientCards.filter((c) => c.health === "good").length;
  const warningCt = clientCards.filter((c) => c.health === "warning").length;
  const badCt = clientCards.filter((c) => c.health === "bad").length;

  // ----- Billing-derived signals -----
  const subs = billing?.subscriptions ?? [];
  const plans = billing?.plans ?? [];
  const billingClients = billing?.clients ?? [];
  const planById = new Map(plans.map((p) => [p.id, p]));
  const clientById = new Map(billingClients.map((c) => [c.id, c]));

  const pastDueSubs = subs.filter((s) => s.status === "past_due");

  const trialsEndingSoon = subs
    .filter(
      (s) =>
        s.status === "trialing" &&
        s.trial_end &&
        new Date(s.trial_end).getTime() > now &&
        new Date(s.trial_end).getTime() < sevenDaysFromNow,
    )
    .sort(
      (a, b) =>
        new Date(a.trial_end!).getTime() - new Date(b.trial_end!).getTime(),
    );

  const upcomingRenewals = subs
    .filter(
      (s) =>
        (s.status === "active" || s.status === "trialing") &&
        s.current_period_end &&
        new Date(s.current_period_end).getTime() > now &&
        new Date(s.current_period_end).getTime() < sevenDaysFromNow,
    )
    .sort(
      (a, b) =>
        new Date(a.current_period_end!).getTime() -
        new Date(b.current_period_end!).getTime(),
    );

  const mrrCents = subs
    .filter((s) => s.status === "active" || s.status === "trialing")
    .reduce(
      (sum, s) =>
        sum + (s.plan_id ? (planById.get(s.plan_id)?.monthly_price_cents ?? 0) : 0),
      0,
    );

  // ----- Inbox-health-derived signals -----
  const inboxes = inbox?.inboxes ?? [];
  const lowHealthInboxes = inboxes
    .filter(
      (i) => i.healthScore !== null && i.healthScore < INBOX_HEALTH_THRESHOLD,
    )
    .sort((a, b) => (a.healthScore ?? 0) - (b.healthScore ?? 0));

  // ----- Step alert signals (already computed by fetchAdminOverview) -----
  const criticalStepAlerts = overview.allStepAlerts.filter(
    (a) => a.severity === "critical",
  );

  const anySignal =
    lowHealthInboxes.length > 0 ||
    pastDueSubs.length > 0 ||
    trialsEndingSoon.length > 0 ||
    criticalStepAlerts.length > 0;

  const attentionClients = clientCards.filter(
    (c) => c.health === "warning" || c.health === "bad",
  );

  return (
    <div className="space-y-6">
      {/* ---------- Band 1 — Header ---------- */}
      <div
        className="relative overflow-hidden rounded-[20px] p-5 sm:p-7"
        style={{
          background:
            "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: "1px solid rgba(46,55,254,0.2)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
        }}
      >
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">
            Welcome back, Daniel
          </p>
          <h1
            className="text-[20px] sm:text-[22px] font-bold mt-1 text-[#0f172a]"
            style={{ letterSpacing: "-0.01em" }}
          >
            Overview
          </h1>
          <div className="flex items-center gap-4 sm:gap-7 mt-4 flex-wrap">
            <div className="text-center">
              <span className="text-[22px] sm:text-[26px] font-bold text-[#0F1880]">
                {totalClients}
              </span>
              <br />
              <span className="text-[10px] text-[#64748b]">Clients</span>
            </div>
            <div className="text-center">
              <span className="text-[22px] sm:text-[26px] font-bold text-[#0F1880]">
                {totalActive}
              </span>
              <br />
              <span className="text-[10px] text-[#64748b]">Active Campaigns</span>
            </div>
            <div className="text-center">
              <span className="text-[22px] sm:text-[26px] font-bold text-[#0F1880]">
                {healthyCt}
              </span>
              <br />
              <span className="text-[10px] text-[#64748b]">Healthy</span>
            </div>
            {warningCt > 0 && (
              <div className="text-center">
                <span className="text-[22px] sm:text-[26px] font-bold text-amber-600">
                  {warningCt}
                </span>
                <br />
                <span className="text-[10px] text-[#64748b]">Warning</span>
              </div>
            )}
            {badCt > 0 && (
              <div className="text-center">
                <span className="text-[22px] sm:text-[26px] font-bold text-red-600">
                  {badCt}
                </span>
                <br />
                <span className="text-[10px] text-[#64748b]">At Risk</span>
              </div>
            )}
            {mrrCents > 0 && (
              <div className="text-center">
                <span className="text-[22px] sm:text-[26px] font-bold text-[#0F1880]">
                  {formatCents(mrrCents)}
                </span>
                <br />
                <span className="text-[10px] text-[#64748b]">MRR</span>
              </div>
            )}
          </div>
        </div>
        <div
          className="absolute -top-10 -right-10 h-40 w-40 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(107,114,255,0.18) 0%, transparent 70%)",
          }}
        />
        <div className="absolute -bottom-6 -right-4 h-24 w-24 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* ---------- Band 2 — Signals ---------- */}
      {anySignal ? (
        <div>
          <SectionHeading
            icon={<AlertTriangle size={16} className="text-white" />}
            title="Needs your attention"
            subtitle="Issues to review now"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {lowHealthInboxes.length > 0 && (
              <Link href="/admin/inbox-health" className="block">
                <StatCard
                  label={`Inboxes below ${INBOX_HEALTH_THRESHOLD}`}
                  value={lowHealthInboxes.length}
                  icon={<Inbox size={18} className="text-amber-600" />}
                  tone="warning"
                />
              </Link>
            )}
            {pastDueSubs.length > 0 && (
              <Link href="/admin/billing" className="block">
                <StatCard
                  label="Subscriptions past due"
                  value={pastDueSubs.length}
                  icon={<CreditCard size={18} className="text-red-600" />}
                  tone="danger"
                />
              </Link>
            )}
            {trialsEndingSoon.length > 0 && (
              <Link href="/admin/billing" className="block">
                <StatCard
                  label="Trials ending in 7d"
                  value={trialsEndingSoon.length}
                  icon={<Clock size={18} className="text-amber-600" />}
                  tone="warning"
                />
              </Link>
            )}
            {criticalStepAlerts.length > 0 && (
              <Link href="/admin/campaigns" className="block">
                <StatCard
                  label="Critical step alerts"
                  value={criticalStepAlerts.length}
                  icon={<TrendingDown size={18} className="text-red-600" />}
                  tone="danger"
                />
              </Link>
            )}
          </div>
        </div>
      ) : (
        <Card className="border-emerald-200 bg-emerald-50/40">
          <CardContent className="py-4 px-5 flex items-center gap-3">
            <CheckCircle2 size={20} className="text-emerald-600 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-emerald-900">
                All systems clear
              </p>
              <p className="text-xs text-emerald-700/80">
                No urgent issues across inboxes, billing, or campaign
                performance.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------- Band 3 — KPI strip ---------- */}
      <div>
        <SectionHeading
          icon={<Activity size={16} className="text-white" />}
          title="At a glance"
          subtitle="Current state · last 7 days for activity"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="MRR"
            value={mrrCents > 0 ? formatCents(mrrCents) : "—"}
            icon={<DollarSign size={18} className="text-emerald-600" />}
            tone={mrrCents > 0 ? "success" : "default"}
          />
          <StatCard
            label="Active campaigns"
            value={totalActive}
            icon={<Send size={18} className="text-[#2E37FE]" />}
          />
          <StatCard
            label="Replies (7d)"
            value={overview.repliesLast7d}
            icon={<MessageSquare size={18} className="text-[#2E37FE]" />}
          />
          <StatCard
            label="Emails sent (7d)"
            value={overview.emailsSentLast7d}
            icon={<Send size={18} className="text-[#2E37FE]" />}
          />
        </div>
      </div>

      {/* ---------- Band 4 — Watchlists ---------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Upcoming billing */}
        <Card className="border-border/50 shadow-sm">
          <CardContent className="pt-5 pb-4 px-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[15px] font-semibold text-[#0f172a]">
                Upcoming billing
              </h3>
              <Link
                href="/admin/billing"
                className="text-xs text-[#2E37FE] font-medium hover:underline"
              >
                View all
              </Link>
            </div>
            {upcomingRenewals.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No renewals in the next 7 days.
              </p>
            ) : (
              <div className="space-y-2">
                {upcomingRenewals.slice(0, 5).map((s) => {
                  const c = clientById.get(s.client_id);
                  const plan = s.plan_id ? planById.get(s.plan_id) : null;
                  const daysOut = daysUntil(s.current_period_end);
                  return (
                    <Link
                      key={s.id}
                      href={`/admin/clients/${s.client_id}`}
                      className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2.5 hover:border-[#2E37FE]/30 hover:bg-[#2E37FE]/[0.02] transition-colors group"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">
                          {c?.name ?? "Unknown client"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {plan?.name ?? "Custom"} · renews{" "}
                          {formatShortDate(s.current_period_end)}
                        </p>
                      </div>
                      <div className="text-right ml-3 shrink-0">
                        <p className="text-sm font-bold text-foreground">
                          {plan ? formatCents(plan.monthly_price_cents) : "—"}
                        </p>
                        {daysOut !== null && (
                          <p className="text-[10px] text-muted-foreground">
                            in {daysOut}d
                          </p>
                        )}
                      </div>
                      <ArrowRight
                        size={14}
                        className="text-muted-foreground ml-2 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-hover:translate-x-0.5"
                      />
                    </Link>
                  );
                })}
                {upcomingRenewals.length > 5 && (
                  <p className="text-xs text-muted-foreground text-center pt-1">
                    +{upcomingRenewals.length - 5} more renewals this week
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Inbox health watchlist */}
        <Card className="border-border/50 shadow-sm">
          <CardContent className="pt-5 pb-4 px-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[15px] font-semibold text-[#0f172a]">
                Inbox health watchlist
              </h3>
              <Link
                href="/admin/inbox-health"
                className="text-xs text-[#2E37FE] font-medium hover:underline"
              >
                View all
              </Link>
            </div>
            {lowHealthInboxes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                All inboxes at or above {INBOX_HEALTH_THRESHOLD}.
              </p>
            ) : (
              <div className="space-y-2">
                {lowHealthInboxes.slice(0, 5).map((i) => {
                  const score = i.healthScore ?? 0;
                  const tone =
                    score < 50
                      ? "bg-red-50 text-red-700 border-red-200"
                      : "bg-amber-50 text-amber-700 border-amber-200";
                  return (
                    <Link
                      key={i.email}
                      href="/admin/inbox-health"
                      className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2.5 hover:border-[#2E37FE]/30 hover:bg-[#2E37FE]/[0.02] transition-colors group"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">
                          {i.email}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {i.domain} · {i.sent30d.toLocaleString()} sent / 30d
                        </p>
                      </div>
                      <Badge
                        variant="secondary"
                        className={`text-xs border ml-3 shrink-0 ${tone}`}
                      >
                        {score}
                      </Badge>
                      <ArrowRight
                        size={14}
                        className="text-muted-foreground ml-2 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-hover:translate-x-0.5"
                      />
                    </Link>
                  );
                })}
                {lowHealthInboxes.length > 5 && (
                  <p className="text-xs text-muted-foreground text-center pt-1">
                    +{lowHealthInboxes.length - 5} more inboxes below{" "}
                    {INBOX_HEALTH_THRESHOLD}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- Band 5 — Clients needing attention ---------- */}
      {attentionClients.length > 0 && (
        <div>
          <SectionHeading
            icon={<AlertCircle size={16} className="text-white" />}
            title="Clients needing attention"
            subtitle={`${attentionClients.length} of ${totalClients} client${totalClients === 1 ? "" : "s"} flagged`}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {attentionClients.map((card) => (
              <ClientCard key={card.client.id} card={card} />
            ))}
          </div>
        </div>
      )}

      {/* ---------- Band 6 — All clients ---------- */}
      {totalClients === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground font-medium">
              No clients yet.
            </p>
            <Link
              href="/admin/clients"
              className="text-sm text-[#2E37FE] font-medium hover:underline mt-1 inline-block"
            >
              Add your first client
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div>
          <SectionHeading
            icon={<Users size={16} className="text-white" />}
            title="All clients"
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {clientCards.map((card) => (
              <ClientCard key={card.client.id} card={card} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
