"use client";

import { useEffect, useMemo, useState } from "react";
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
import { PageHeader } from "@/components/layout/page-header";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Sparkline } from "@/components/charts/sparkline";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { DollarSign, Trash2 } from "lucide-react";
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

// Health colour, keyed off riskScore, drives the status dot + the health label.
// Single source so the roster dot and the Portfolio Pulse legend never drift.
function healthDotColor(score: number): string {
  return score === 3 ? "#dc2626" : score === 2 ? "#d97706" : score === 1 ? "#64748b" : "#059669";
}
function healthTextClass(score: number): string {
  return score === 3
    ? "text-red-600"
    : score === 2
      ? "text-amber-600"
      : score === 1
        ? "text-slate-500"
        : "text-emerald-600";
}

// Column tone rules (unchanged from the old table): good reply is high, good
// bounce is low.
function replyTone(r: number): string {
  return r >= 5 ? "text-emerald-600" : r >= 2 ? "text-amber-600" : "text-red-600";
}
function bounceTone(r: number): string {
  return r <= 2 ? "text-emerald-600" : r <= 5 ? "text-amber-600" : "text-red-600";
}

// Rank a subscription's relevance when a client has more than one: the most
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

// Sort options. The old table sorted by clicking column headers; the dense
// roster has no header row, so sorting moves to a compact control with a fixed,
// sensible direction per field (worst-health-first, biggest-MRR-first, etc.).
const SORT_OPTIONS = [
  { key: "riskScore", dir: "desc", label: "Health" },
  { key: "mrrCents", dir: "desc", label: "MRR" },
  { key: "reply_rate", dir: "desc", label: "Reply rate" },
  { key: "bounce_rate", dir: "desc", label: "Bounce rate" },
  { key: "positive", dir: "desc", label: "Positive" },
  { key: "renewSort", dir: "asc", label: "Renews soonest" },
  { key: "name", dir: "asc", label: "Name (A-Z)" },
] as const;

// ---------- Portfolio Pulse (canonical status card) ----------
// Replaces the four separate segment chips with one consolidated card: a hero
// MRR figure + a proportional health-distribution meter + a legend. Same card
// on mobile and desktop.
function PortfolioPulse({
  mrrCents,
  totalClients,
  badCt,
  warningCt,
  noneCt,
  healthyCt,
}: {
  mrrCents: number;
  totalClients: number;
  badCt: number;
  warningCt: number;
  noneCt: number;
  healthyCt: number;
}) {
  const segs = [
    { ct: badCt, color: "#dc2626", label: "At risk", always: true },
    { ct: warningCt, color: "#d97706", label: "Warning", always: true },
    { ct: noneCt, color: "#64748b", label: "No data", always: false },
    { ct: healthyCt, color: "#059669", label: "Healthy", always: true },
  ];
  const barTotal = badCt + warningCt + noneCt + healthyCt;

  return (
    <div className="rounded-[20px] border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Total MRR
          </p>
          <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-foreground">
            {mrrCents > 0 ? formatCents(mrrCents) : "—"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {totalClients} active {totalClients === 1 ? "client" : "clients"}
          </p>
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#EDEEFF] text-[#1C24B8]">
          <DollarSign size={20} />
        </div>
      </div>

      {/* Health-distribution meter */}
      <div className="mt-4 flex h-3 gap-1">
        {barTotal === 0 ? (
          <div className="h-full flex-1 rounded-full bg-muted" />
        ) : (
          segs
            .filter((s) => s.ct > 0)
            .map((s) => (
              <div
                key={s.label}
                className="h-full min-w-[6px] rounded-full"
                style={{ flex: `${s.ct} 1 0%`, background: s.color }}
              />
            ))
        )}
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        {segs
          .filter((s) => s.always || s.ct > 0)
          .map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: s.color }}
              />
              <span>
                <span className="font-semibold tabular-nums text-foreground">
                  {s.ct}
                </span>{" "}
                {s.label}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ---------- Client row (canonical roster item, all breakpoints) ----------
// One dense, rounded, tap-through row used on both mobile and desktop. A leading
// status dot + a coloured health label carry health (never colour alone). The
// send-volume sparkline shows on desktop where there's room; former clients get
// a delete affordance overlaid top-right (kept out of the <Link> tap target).
function ClientRow({
  row,
  onDelete,
}: {
  row: OverviewRow;
  onDelete?: () => void;
}) {
  const href = `/admin/clients/${row.id}`;
  const dot = healthDotColor(row.riskScore);

  return (
    <div className="relative">
      <Link
        href={href}
        className={cn(
          "block rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/30 active:bg-muted/50",
          onDelete && "pr-11",
        )}
      >
        {/* Top line: dot + name, MRR + renew right */}
        <div className="flex items-start gap-3">
          <span
            className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: dot }}
          />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {row.name}
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-sm font-semibold tabular-nums text-foreground">
              {row.mrrCents != null ? formatCents(row.mrrCents) : "—"}
            </span>
            <span
              className={cn(
                "block text-[11px] font-medium",
                row.renewTone === "red"
                  ? "text-red-600"
                  : row.renewTone === "amber"
                    ? "text-amber-600"
                    : "text-muted-foreground",
              )}
            >
              {row.renewLabel}
            </span>
          </span>
        </div>

        {/* Meta line: health label + campaign counts + optional step alert */}
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 pl-[22px] text-xs">
          <span className={cn("font-medium", healthTextClass(row.riskScore))}>
            {row.healthLabel}
          </span>
          <span className="text-muted-foreground">
            · {row.activeCount} active / {row.totalCount} total
          </span>
          {row.alertReason && (
            <span className="text-muted-foreground">· {row.alertReason}</span>
          )}
        </div>

        {/* Stats line: reply / bounce / positive, sparkline on desktop */}
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-dashed border-border/70 pt-2.5 pl-[22px]">
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>
              Reply{" "}
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  row.hasData ? replyTone(row.reply_rate) : "text-muted-foreground",
                )}
              >
                {row.hasData ? `${row.reply_rate}%` : "—"}
              </span>
            </span>
            <span className="text-border">·</span>
            <span>
              Bounce{" "}
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  row.hasData ? bounceTone(row.bounce_rate) : "text-muted-foreground",
                )}
              >
                {row.hasData ? `${row.bounce_rate}%` : "—"}
              </span>
            </span>
            <span className="text-border">·</span>
            <span>
              Positive{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {row.hasData ? row.positive : "—"}
              </span>
            </span>
          </div>
          <span className="hidden shrink-0 lg:block">
            <Sparkline values={row.trend} />
          </span>
        </div>
      </Link>

      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${row.name}`}
          className="absolute right-3 top-3 z-10 inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

// ---------- Page ----------
export default function AdminOverviewPage() {
  const { data: overview, loading: ovLoading, refetch: refetchOverview } = useSupabaseQuery(
    ADMIN_OVERVIEW_KEY,
    fetchAdminOverview,
  );
  // Pre-warmed by AdminPrefetcher: shares that cache instead of a second
  // round-trip to Supabase.
  const { data: billing } = useApiQuery<BillingDataResponse>(
    API_BILLING_DATA_PATH,
  );

  const [clientFilter, setClientFilter] = useState<ClientStatus>("active");
  // KPI time-window lens for the reply/bounce/positive columns. Defaults to
  // All-Time: a rolling 30-day reply rate understated it (fresh, unreplied
  // leads dilute the denominator). 7d/30d derive client-side from card.snapshots.
  const [period, setPeriod] = useState<MetricsPeriod>(DEFAULT_METRICS_PERIOD);
  const [sortIdx, setSortIdx] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [page, setPage] = useState(1);

  // Capture once per page instance so date math during render is referentially
  // stable (react-hooks/purity). The dashboard isn't a live clock: the SWR
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

  // Local sort (fixed direction per field; the dense list has no clickable
  // column headers to toggle).
  const sorted = useMemo(() => {
    const { key, dir } = SORT_OPTIONS[sortIdx];
    return [...displayRows].sort((a, b) => {
      const av = a[key as keyof OverviewRow];
      const bv = b[key as keyof OverviewRow];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return dir === "asc" ? av - bv : bv - av;
      }
      const as = String(av).toLowerCase();
      const bs = String(bv).toLowerCase();
      if (as < bs) return dir === "asc" ? -1 : 1;
      if (as > bs) return dir === "asc" ? 1 : -1;
      return 0;
    });
  }, [displayRows, sortIdx]);

  useEffect(() => {
    setPage(1);
  }, [sortIdx, clientFilter, period]);

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
    // Revalidate the overview cache so the deleted client drops out: a full
    // page reload would re-run the entire dashboard query set unnecessarily.
    await refetchOverview();
  }

  if (ovLoading || !overview) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-32 rounded-[20px] bg-muted/50" />
        <div className="space-y-2.5">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-24 rounded-2xl bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  const healthyCt = activeRows.filter((r) => r.riskScore === 0).length;
  const noneCt = activeRows.filter((r) => r.riskScore === 1).length;
  const warningCt = activeRows.filter((r) => r.riskScore === 2).length;
  const badCt = activeRows.filter((r) => r.riskScore === 3).length;
  const totalClients = activeRows.length;

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" />

      {/* ---------- Portfolio Pulse ---------- */}
      <PortfolioPulse
        mrrCents={mrrCentsTotal}
        totalClients={totalClients}
        badCt={badCt}
        warningCt={warningCt}
        noneCt={noneCt}
        healthyCt={healthyCt}
      />

      {/* ---------- Roster ---------- */}
      {activeRows.length === 0 && formerRows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card py-12 text-center">
          <p className="font-medium text-muted-foreground">No clients yet.</p>
          <Link
            href="/admin/clients"
            className="mt-1 inline-block text-sm font-medium text-primary hover:underline"
          >
            Add your first client
          </Link>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold text-foreground">
                {clientFilter === "active" ? "Book of business" : "Former clients"}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Reply, bounce &amp; positive reflect {PERIOD_BLURBS[period]}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PeriodToggle period={period} onChange={setPeriod} />
              <select
                value={sortIdx}
                onChange={(e) => setSortIdx(Number(e.target.value))}
                aria-label="Sort clients"
                className="h-9 rounded-lg border border-input bg-card px-3 text-sm text-foreground"
              >
                {SORT_OPTIONS.map((o, i) => (
                  <option key={o.key} value={i}>
                    Sort: {o.label}
                  </option>
                ))}
              </select>
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
            <div className="rounded-2xl border border-border bg-card py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {clientFilter === "active"
                  ? "No active clients. Check the Former tab or add a new client."
                  : "No former clients."}
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-2.5">
                {pageRows.map((row) => (
                  <ClientRow
                    key={row.id}
                    row={row}
                    onDelete={
                      row.status === "former"
                        ? () => setDeleteTarget({ id: row.id, name: row.name })
                        : undefined
                    }
                  />
                ))}
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
