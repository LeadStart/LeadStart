"use client";

import { useEffect, useState } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  ADMIN_OVERVIEW_KEY,
  API_BILLING_DATA_PATH,
  fetchAdminOverview,
  deriveCardHealth,
  type AdminOverviewCard,
} from "@/lib/admin-queries";
import { calculateMetrics } from "@/lib/kpi/calculator";
import {
  filterSnapshotsByPeriod,
  DEFAULT_METRICS_PERIOD,
  PERIOD_BLURBS,
  type MetricsPeriod,
} from "@/lib/kpi/period";
import { PeriodToggle } from "@/components/kpi/period-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableHead } from "@/components/ui/sortable-head";
import { useSort } from "@/hooks/use-sort";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Sparkline } from "@/components/charts/sparkline";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Link from "next/link";
import {
  ArrowRight,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  DollarSign,
  Trash2,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { createClient } from "@/lib/supabase/client";
import type {
  ClientSubscription,
  PricingPlan,
  Client,
  ClientStatus,
  BillingInvoice,
  Quote,
} from "@/types/app";

const OVERVIEW_PAGE_SIZE = 25;

// ---------- API response shapes (cached endpoints) ----------
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
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}k`;
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

function daysUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - now) / 86400000);
}

const HEALTH_META: Record<
  "good" | "warning" | "bad" | "none",
  { label: string; badge: string; score: number }
> = {
  bad: { label: "At risk", badge: "badge-red", score: 3 },
  warning: { label: "Step drop", badge: "badge-amber", score: 2 },
  none: { label: "No data", badge: "badge-slate", score: 1 },
  good: { label: "Healthy", badge: "badge-green", score: 0 },
};

// Rank a subscription's relevance when a client has more than one — the most
// billing-urgent status wins the row.
function subRank(status: string): number {
  return status === "past_due"
    ? 0
    : status === "trialing"
      ? 1
      : status === "active"
        ? 2
        : 3;
}

type OverviewRow = {
  card: AdminOverviewCard;
  id: string;
  name: string;
  initial: string;
  status: ClientStatus;
  hasData: boolean;
  healthLabel: string;
  healthBadge: string;
  riskScore: number;
  alertReason: string | null;
  activeCount: number;
  totalCount: number;
  reply_rate: number;
  bounce_rate: number;
  positive: number;
  trend: number[];
  mrrCents: number | null;
  renewLabel: string;
  renewTone: "red" | "amber" | "muted";
  renewSort: number;
};

// ---------- Segment chip ----------
function SegmentChip({
  icon,
  value,
  label,
  valueClass = "text-foreground",
}: {
  icon: React.ReactNode;
  value: string | number;
  label: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <p className={`text-xl font-bold leading-none ${valueClass}`}>{value}</p>
        <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
      </div>
    </div>
  );
}

// ---------- Mobile roster card ----------
// The desktop "Book of business" table is 9 columns wide; on a phone it becomes
// a sideways-scrolling mess. Below `lg` we render each client as a tap-through
// card instead, surfacing the same numbers stacked. Delete-former lives on the
// desktop table / the client page — kept off the card so the whole thing is one
// clean tap target (no nested interactive elements inside the <Link>).
function replyTone(r: number): string {
  return r >= 5 ? "text-emerald-600" : r >= 2 ? "text-amber-600" : "text-red-600";
}
function bounceTone(r: number): string {
  return r <= 2 ? "text-emerald-600" : r <= 5 ? "text-amber-600" : "text-red-600";
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`text-sm font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

function MobileClientCard({ row }: { row: OverviewRow }) {
  const href = `/admin/clients/${row.id}`;
  return (
    <Link
      href={href}
      className="block rounded-xl border border-border bg-card p-4 transition-colors active:bg-muted/40"
    >
      <div className="flex items-center gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0"
          style={{ background: "#2E37FE" }}
        >
          {row.initial}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground truncate">{row.name}</p>
          <p className="text-xs text-muted-foreground">
            {row.activeCount} active / {row.totalCount} total
          </p>
        </div>
        <Badge variant="secondary" className={`${row.healthBadge} shrink-0`}>
          {row.healthLabel}
        </Badge>
      </div>
      {row.alertReason && (
        <p className="mt-2 text-[11px] text-muted-foreground">{row.alertReason}</p>
      )}
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
        <MiniStat
          label="Reply"
          value={row.hasData ? `${row.reply_rate}%` : "—"}
          tone={row.hasData ? replyTone(row.reply_rate) : "text-muted-foreground"}
        />
        <MiniStat
          label="Bounce"
          value={row.hasData ? `${row.bounce_rate}%` : "—"}
          tone={row.hasData ? bounceTone(row.bounce_rate) : "text-muted-foreground"}
        />
        <MiniStat
          label="Positive"
          value={row.hasData ? String(row.positive) : "—"}
          tone="text-foreground"
        />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          MRR{" "}
          <span className="font-semibold text-foreground">
            {row.mrrCents != null ? formatCents(row.mrrCents) : "—"}
          </span>
        </span>
        <span className="text-muted-foreground">
          Renews{" "}
          <span
            className={`font-semibold ${
              row.renewTone === "red"
                ? "text-red-600"
                : row.renewTone === "amber"
                  ? "text-amber-600"
                  : "text-foreground"
            }`}
          >
            {row.renewLabel}
          </span>
        </span>
      </div>
    </Link>
  );
}

// ---------- Page ----------
export default function AdminOverviewPage() {
  const { data: overview, loading: ovLoading, refetch: refetchOverview } = useSupabaseQuery(
    ADMIN_OVERVIEW_KEY,
    fetchAdminOverview,
  );
  // Pre-warmed by AdminPrefetcher — shares that cache instead of a second
  // round-trip to Supabase.
  const { data: billing } = useApiQuery<BillingDataResponse>(
    API_BILLING_DATA_PATH,
  );

  const [clientFilter, setClientFilter] = useState<ClientStatus>("active");
  // KPI time-window lens for the reply/bounce/positive columns. Defaults to
  // All-Time — a rolling 30-day reply rate understated it (fresh, unreplied
  // leads dilute the denominator). 7d/30d derive client-side from card.snapshots.
  const [period, setPeriod] = useState<MetricsPeriod>(DEFAULT_METRICS_PERIOD);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [page, setPage] = useState(1);

  // Capture once per page instance so date math during render is referentially
  // stable (react-hooks/purity). The dashboard isn't a live clock — the SWR
  // cache lags too; navigating refreshes both.
  const [now] = useState<number>(() => Date.now());

  // ----- Billing lookups -----
  const subs = billing?.subscriptions ?? [];
  const plans = billing?.plans ?? [];
  const planById = new Map(plans.map((p) => [p.id, p]));
  const subByClient = new Map<string, ClientSubscription>();
  for (const s of subs) {
    const cur = subByClient.get(s.client_id);
    if (!cur || subRank(s.status) < subRank(cur.status)) {
      subByClient.set(s.client_id, s);
    }
  }
  const mrrCentsTotal = subs
    .filter((s) => s.status === "active" || s.status === "trialing")
    .reduce(
      (sum, s) =>
        sum +
        (s.plan_id ? (planById.get(s.plan_id)?.monthly_price_cents ?? 0) : 0),
      0,
    );

  // ----- Build rows -----
  const allCards = overview?.cards ?? [];
  const rows: OverviewRow[] = allCards.map((card) => {
    const { client, stepAlerts, activeCampaigns } = card;
    // All-Time is the baked default; recompute only when a narrower lens is
    // picked. `now` is render-stable so the filter stays pure.
    const metrics =
      period === "all"
        ? card.metrics
        : calculateMetrics(filterSnapshotsByPeriod(card.snapshots, period, now));
    const health =
      period === "all" ? card.health : deriveCardHealth(metrics, stepAlerts);
    const meta = HEALTH_META[health];
    const hasData = metrics.emails_sent > 0;

    const top = stepAlerts[0];
    let alertReason: string | null = null;
    if (top) {
      const metricLabel =
        top.metric === "reply_rate"
          ? "reply"
          : top.metric === "bounce_rate"
            ? "bounce"
            : top.metric;
      const sign = top.change_pct > 0 ? "+" : "";
      alertReason = `Step ${top.step} ${metricLabel} ${top.current_value}% (${sign}${top.change_pct}%)`;
    }

    const sub = subByClient.get(client.id);
    const plan = sub?.plan_id ? planById.get(sub.plan_id) : null;
    const mrrCents = plan ? plan.monthly_price_cents : null;

    let renewLabel = "—";
    let renewTone: "red" | "amber" | "muted" = "muted";
    let renewSort = Number.POSITIVE_INFINITY;
    if (sub?.status === "past_due") {
      renewLabel = "Past due";
      renewTone = "red";
      renewSort = -1;
    } else if (sub?.status === "trialing") {
      const d = daysUntil(sub.trial_end, now);
      renewLabel = d != null ? `Trial · ${Math.max(0, d)}d` : "Trial";
      renewTone = d != null && d <= 7 ? "amber" : "muted";
      renewSort = d ?? 9998;
    } else if (sub?.status === "active") {
      const d = daysUntil(sub.current_period_end, now);
      renewLabel = formatShortDate(sub.current_period_end);
      renewTone = d != null && d <= 7 ? "amber" : "muted";
      renewSort = d ?? 9997;
    }

    return {
      card,
      id: client.id,
      name: client.name,
      initial: client.name.charAt(0).toUpperCase(),
      status: (client.status ?? "active") as ClientStatus,
      hasData,
      healthLabel: meta.label,
      healthBadge: meta.badge,
      riskScore: meta.score,
      alertReason,
      activeCount: activeCampaigns.length,
      totalCount: card.clientCampaigns.length,
      reply_rate: metrics.reply_rate,
      bounce_rate: metrics.bounce_rate,
      positive: metrics.meetings_booked,
      trend: card.trend,
      mrrCents,
      renewLabel,
      renewTone,
      renewSort,
    };
  });

  const activeRows = rows.filter((r) => r.status === "active");
  const formerRows = rows.filter((r) => r.status === "former");
  const displayRows = clientFilter === "active" ? activeRows : formerRows;

  const { sorted, sortConfig, requestSort } = useSort(
    displayRows,
    "riskScore",
    "desc",
  );

  useEffect(() => {
    setPage(1);
  }, [sortConfig?.key, sortConfig?.direction, clientFilter, period]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / OVERVIEW_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * OVERVIEW_PAGE_SIZE;
  const pageRows = sorted.slice(pageStart, pageStart + OVERVIEW_PAGE_SIZE);

  async function deleteClient(clientId: string) {
    setDeleting(true);
    const supabase = createClient();
    await supabase.from("contacts").delete().eq("client_id", clientId);
    const { error } = await supabase.from("clients").delete().eq("id", clientId);
    setDeleting(false);
    setDeleteTarget(null);
    if (error) {
      console.error("Failed to delete client:", error);
      alert(`Could not delete client: ${error.message}`);
      return;
    }
    // Revalidate the overview cache so the deleted client drops out — a full
    // page reload would re-run the entire dashboard query set unnecessarily.
    await refetchOverview();
  }

  if (ovLoading || !overview) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-24 bg-muted/50" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl h-20 bg-muted/50" />
          ))}
        </div>
        <div className="rounded-xl h-80 bg-muted/50" />
      </div>
    );
  }

  const healthyCt = activeRows.filter((r) => r.riskScore === 0).length;
  const warningCt = activeRows.filter((r) => r.riskScore === 2).length;
  const badCt = activeRows.filter((r) => r.riskScore === 3).length;
  const totalClients = activeRows.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
      />

      {/* ---------- Segment chips ---------- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SegmentChip
          icon={<AlertTriangle size={18} className="text-red-600" />}
          value={badCt}
          label="At risk"
          valueClass={badCt > 0 ? "text-red-600" : "text-foreground"}
        />
        <SegmentChip
          icon={<AlertCircle size={18} className="text-amber-600" />}
          value={warningCt}
          label="Warning"
          valueClass={warningCt > 0 ? "text-amber-600" : "text-foreground"}
        />
        <SegmentChip
          icon={<CheckCircle2 size={18} className="text-emerald-600" />}
          value={healthyCt}
          label="Healthy"
          valueClass="text-emerald-600"
        />
        <SegmentChip
          icon={<DollarSign size={18} className="text-[#2E37FE]" />}
          value={mrrCentsTotal > 0 ? formatCents(mrrCentsTotal) : "—"}
          label="Total MRR"
        />
      </div>

      {/* ---------- Portfolio table ---------- */}
      {activeRows.length === 0 && formerRows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card py-12 text-center">
          <p className="font-medium text-muted-foreground">No clients yet.</p>
          <Link
            href="/admin/clients"
            className="mt-1 inline-block text-sm font-medium text-[#2E37FE] hover:underline"
          >
            Add your first client
          </Link>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold text-[#0f172a]">
                {clientFilter === "active" ? "Book of business" : "Former clients"}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Reply, bounce &amp; positive reflect {PERIOD_BLURBS[period]} ·
                click a column to sort
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <PeriodToggle period={period} onChange={setPeriod} />
              <Tabs
                value={clientFilter}
                onValueChange={(v) => setClientFilter(v as ClientStatus)}
              >
                <TabsList>
                  <TabsTrigger value="active">
                    Current ({activeRows.length})
                  </TabsTrigger>
                  <TabsTrigger value="former">
                    Former ({formerRows.length})
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>

          {displayRows.length === 0 ? (
            <div className="rounded-xl border border-border bg-card py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {clientFilter === "active"
                  ? "No active clients. Check the Former tab or add a new client."
                  : "No former clients."}
              </p>
            </div>
          ) : (
            <>
              {/* Mobile: stacked tap-through cards (the 9-col table can't fit) */}
              <div className="space-y-2.5 lg:hidden">
                {pageRows.map((row) => (
                  <MobileClientCard key={row.id} row={row} />
                ))}
              </div>
              {/* Desktop: full sortable table */}
              <div className="hidden lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead
                      sortKey="name"
                      sortConfig={sortConfig}
                      onSort={requestSort}
                    >
                      Client
                    </SortableHead>
                    <SortableHead
                      sortKey="riskScore"
                      sortConfig={sortConfig}
                      onSort={requestSort}
                    >
                      Health
                    </SortableHead>
                    <SortableHead
                      sortKey="reply_rate"
                      sortConfig={sortConfig}
                      onSort={requestSort}
                      className="text-right"
                    >
                      Reply
                    </SortableHead>
                    <SortableHead
                      sortKey="bounce_rate"
                      sortConfig={sortConfig}
                      onSort={requestSort}
                      className="text-right"
                    >
                      Bounce
                    </SortableHead>
                    <SortableHead
                      sortKey="positive"
                      sortConfig={sortConfig}
                      onSort={requestSort}
                      className="text-right"
                    >
                      Positive
                    </SortableHead>
                    <TableHead title="Send volume, last 30 days">Trend</TableHead>
                    <SortableHead
                      sortKey="mrrCents"
                      sortConfig={sortConfig}
                      onSort={requestSort}
                      className="text-right"
                    >
                      MRR
                    </SortableHead>
                    <SortableHead
                      sortKey="renewSort"
                      sortConfig={sortConfig}
                      onSort={requestSort}
                      className="text-right"
                    >
                      Renews
                    </SortableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => {
                    const href = `/admin/clients/${row.id}`;
                    return (
                      <TableRow key={row.id} href={href} className="group">
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0"
                              style={{ background: "#2E37FE" }}
                            >
                              {row.initial}
                            </div>
                            <div className="min-w-0">
                              <Link
                                href={href}
                                className="font-medium text-foreground transition-colors hover:text-[#2E37FE]"
                              >
                                {row.name}
                              </Link>
                              <p className="text-xs text-muted-foreground">
                                {row.activeCount} active / {row.totalCount} total
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={row.healthBadge}
                          >
                            {row.healthLabel}
                          </Badge>
                          {row.alertReason && (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {row.alertReason}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.hasData ? (
                            <span
                              className={
                                row.reply_rate >= 5
                                  ? "font-medium text-emerald-600"
                                  : row.reply_rate >= 2
                                    ? "text-amber-600"
                                    : "font-medium text-red-600"
                              }
                            >
                              {row.reply_rate}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.hasData ? (
                            <span
                              className={
                                row.bounce_rate <= 2
                                  ? "text-emerald-600"
                                  : row.bounce_rate <= 5
                                    ? "text-amber-600"
                                    : "font-medium text-red-600"
                              }
                            >
                              {row.bounce_rate}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {row.hasData ? (
                            row.positive
                          ) : (
                            <span className="font-normal text-muted-foreground">
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Sparkline values={row.trend} />
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {row.mrrCents != null ? (
                            formatCents(row.mrrCents)
                          ) : (
                            <span className="font-normal text-muted-foreground">
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <span
                            className={
                              row.renewTone === "red"
                                ? "font-medium text-red-600"
                                : row.renewTone === "amber"
                                  ? "font-medium text-amber-600"
                                  : "text-muted-foreground"
                            }
                          >
                            {row.renewLabel}
                          </span>
                        </TableCell>
                        <TableCell className="w-[72px]">
                          <div className="flex items-center justify-end gap-1">
                            <Link
                              href={href}
                              aria-label={`Open ${row.name}`}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted/50 hover:text-foreground group-hover:opacity-100"
                            >
                              <ArrowRight size={14} />
                            </Link>
                            {row.status === "former" && (
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="text-muted-foreground hover:bg-red-50 hover:text-red-600"
                                onClick={() =>
                                  setDeleteTarget({
                                    id: row.id,
                                    name: row.name,
                                  })
                                }
                                aria-label={`Delete ${row.name}`}
                              >
                                <Trash2 size={14} />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </div>
              <PaginationControls
                currentPage={safePage}
                totalItems={sorted.length}
                pageSize={OVERVIEW_PAGE_SIZE}
                onPageChange={setPage}
              />
            </>
          )}
        </div>
      )}

      {/* ---------- Delete confirmation dialog ---------- */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Permanently delete {deleteTarget?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will also delete all contacts associated with this client
              from the database. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                if (deleteTarget) deleteClient(deleteTarget.id);
              }}
            >
              {deleting ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
