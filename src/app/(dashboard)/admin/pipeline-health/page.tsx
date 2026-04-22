"use client";

// D4 — Pipeline health dashboard. Single read-only admin view that answers
// "is the reply-chain alive right now?" Pulls state the earlier SAFETY-TODO
// commits already populate (webhook_events, lead_replies.notification_status,
// campaigns.client_id, webhook_auth_failures). No writes, no schema changes.

import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import {
  ADMIN_PIPELINE_HEALTH_KEY,
  fetchAdminPipelineHealth,
} from "@/lib/admin-queries";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/charts/stat-card";
import {
  Activity,
  Bell,
  Flame,
  AlertTriangle,
  Shield,
  RefreshCw,
  MailCheck,
  MailX,
  Hourglass,
  Link2Off,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";

const PULSE_AMBER_MS = 1 * 60 * 60 * 1000; // 1h
const PULSE_RED_MS = 4 * 60 * 60 * 1000; // 4h

type PulseStatus = "green" | "amber" | "red" | "none";

function classifyPulse(lastReceivedAt: string | null): PulseStatus {
  if (!lastReceivedAt) return "none";
  const ageMs = Date.now() - Date.parse(lastReceivedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "green";
  if (ageMs > PULSE_RED_MS) return "red";
  if (ageMs > PULSE_AMBER_MS) return "amber";
  return "green";
}

function formatAge(lastReceivedAt: string | null): string {
  if (!lastReceivedAt) return "never";
  const ageMs = Date.now() - Date.parse(lastReceivedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

const PULSE_COPY: Record<PulseStatus, { label: string; hint: string }> = {
  green: {
    label: "Pipeline receiving events",
    hint: "Last webhook within the expected cadence.",
  },
  amber: {
    label: "Quiet — over an hour since last event",
    hint: "Normal outside business hours; investigate if it persists.",
  },
  red: {
    label: "Stale — over 4 hours since last event",
    hint: "Verify the Instantly webhook is registered and WEBHOOK_SECRET matches Vercel env.",
  },
  none: {
    label: "No webhook events on record",
    hint: "Either the webhook isn't registered yet or the table is empty.",
  },
};

const PULSE_STYLES: Record<
  PulseStatus,
  { bg: string; border: string; icon: React.ReactNode; text: string }
> = {
  green: {
    bg: "linear-gradient(135deg, #ECFDF5 0%, #D1FAE5 50%, #fff 100%)",
    border: "1px solid rgba(16,185,129,0.25)",
    icon: <CheckCircle2 size={18} className="text-emerald-700" />,
    text: "#065F46",
  },
  amber: {
    bg: "linear-gradient(135deg, #FFFBEB 0%, #FEF3C7 50%, #fff 100%)",
    border: "1px solid rgba(217,119,6,0.25)",
    icon: <Clock size={18} className="text-amber-700" />,
    text: "#92400E",
  },
  red: {
    bg: "linear-gradient(135deg, #FEF2F2 0%, #FEE2E2 50%, #fff 100%)",
    border: "1px solid rgba(220,38,38,0.25)",
    icon: <XCircle size={18} className="text-red-700" />,
    text: "#991B1B",
  },
  none: {
    bg: "linear-gradient(135deg, #F8FAFC 0%, #F1F5F9 50%, #fff 100%)",
    border: "1px solid rgba(100,116,139,0.25)",
    icon: <Activity size={18} className="text-slate-600" />,
    text: "#334155",
  },
};

export default function PipelineHealthPage() {
  const { data, loading, error, refetch, refreshing } = useSupabaseQuery(
    ADMIN_PIPELINE_HEALTH_KEY,
    fetchAdminPipelineHealth,
  );

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-36 bg-muted/50" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl h-24 bg-muted/50" />
          ))}
        </div>
        <div className="rounded-xl h-48 bg-muted/50" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <Header onRefresh={() => void refetch()} refreshing={refreshing} />
        <Card className="border-red-200">
          <CardContent className="py-8 text-center">
            <AlertTriangle size={32} className="text-red-700 mx-auto mb-3" />
            <p className="text-sm font-medium text-red-600">{error}</p>
            <button
              onClick={() => void refetch()}
              className="mt-3 text-sm text-[#2E37FE] hover:underline"
            >
              Retry
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const pipeline = data;
  if (!pipeline) {
    return (
      <div className="space-y-6">
        <Header onRefresh={() => void refetch()} refreshing={refreshing} />
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No data yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  const pulse = classifyPulse(pipeline.webhookEvents.lastReceivedAt);
  const pulseStyle = PULSE_STYLES[pulse];
  const pulseCopy = PULSE_COPY[pulse];
  const notifProblems =
    pipeline.notifications.failed +
    pipeline.notifications.retrying +
    pipeline.notifications.bounced;
  const authFailTone =
    pipeline.authFailures24h >= 5
      ? "text-red-600"
      : pipeline.authFailures24h > 0
        ? "text-amber-600"
        : "text-emerald-600";
  const orphanTone =
    pipeline.orphanCampaigns > 0 ? "text-amber-600" : "text-emerald-600";

  return (
    <div className="space-y-6">
      <Header onRefresh={() => void refetch()} refreshing={refreshing} />

      {/* Pipeline pulse banner */}
      <div
        className="relative overflow-hidden rounded-[20px] p-5 sm:p-6"
        style={{
          background: pulseStyle.bg,
          border: pulseStyle.border,
          boxShadow: "0 4px 14px rgba(15,23,42,0.05)",
        }}
      >
        <div className="relative z-10 flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/70 shrink-0">
              {pulseStyle.icon}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-[#64748b]">
                Pipeline pulse
              </p>
              <p
                className="text-[18px] font-bold mt-0.5"
                style={{ color: pulseStyle.text, letterSpacing: "-0.01em" }}
              >
                {pulseCopy.label}
              </p>
              <p className="text-xs text-[#0f172a]/70 mt-1 max-w-md">
                {pulseCopy.hint}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-medium uppercase tracking-wider text-[#64748b]">
              Last event
            </p>
            <p
              className="text-[18px] font-bold"
              style={{ color: pulseStyle.text, letterSpacing: "-0.01em" }}
            >
              {formatAge(pipeline.webhookEvents.lastReceivedAt)}
            </p>
            {pipeline.webhookEvents.lastReceivedAt && (
              <p className="text-[10px] text-[#0f172a]/60 font-mono mt-0.5">
                {new Date(pipeline.webhookEvents.lastReceivedAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* 4 headline stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Webhook events (24h)"
          value={pipeline.webhookEvents.total24h}
          icon={<Bell size={18} className="text-[#2E37FE]" />}
          iconBg="bg-[#2E37FE]/10"
        />
        <StatCard
          label="Replies classified (24h)"
          value={pipeline.replies24h.classifiedTotal}
          icon={<Activity size={18} className="text-indigo-500" />}
          iconBg="bg-indigo-50"
        />
        <StatCard
          label="Orphan campaigns"
          value={pipeline.orphanCampaigns}
          icon={<Link2Off size={18} className="text-amber-500" />}
          iconBg="bg-amber-50"
          valueColor={orphanTone}
        />
        <StatCard
          label="Auth failures (24h)"
          value={pipeline.authFailures24h}
          icon={<Shield size={18} className="text-red-500" />}
          iconBg="bg-red-50"
          valueColor={authFailTone}
        />
      </div>

      {/* Detail row: replies breakdown + notifications + stuck + top events */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="border-border/50 shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
                <Flame size={16} className="text-white" />
              </div>
              <h2 className="text-[15px] font-semibold text-[#0f172a]">
                Replies (24h)
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <BreakdownTile
                label="Hot"
                value={pipeline.replies24h.hot}
                tone={pipeline.replies24h.hot > 0 ? "emerald" : "slate"}
              />
              <BreakdownTile
                label="Non-hot"
                value={pipeline.replies24h.nonHot}
                tone="slate"
              />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[#64748b] mb-2">
                Top event types (24h)
              </p>
              {pipeline.webhookEvents.byType.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No events received in the last 24h.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {pipeline.webhookEvents.byType.map((r) => (
                    <li
                      key={r.event_type}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="font-mono text-[#0f172a]/80 text-xs">
                        {r.event_type}
                      </span>
                      <Badge
                        variant="secondary"
                        className="bg-[#2E37FE]/10 text-[#6B72FF] border border-[#2E37FE]/20 text-[11px]"
                      >
                        {r.count}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/50 shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
                  <MailCheck size={16} className="text-white" />
                </div>
                <h2 className="text-[15px] font-semibold text-[#0f172a]">
                  Notifications (7d)
                </h2>
              </div>
              {notifProblems > 0 ? (
                <Badge className="badge-amber text-[11px]">
                  {notifProblems} need attention
                </Badge>
              ) : (
                <Badge className="badge-green text-[11px]">Healthy</Badge>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <BreakdownTile
                label="Sent"
                value={pipeline.notifications.sent}
                tone="emerald"
              />
              <BreakdownTile
                label="Pending"
                value={pipeline.notifications.pending}
                tone={pipeline.notifications.pending > 0 ? "amber" : "slate"}
              />
              <BreakdownTile
                label="Failed / retrying"
                value={
                  pipeline.notifications.failed +
                  pipeline.notifications.retrying
                }
                tone={
                  pipeline.notifications.failed +
                    pipeline.notifications.retrying >
                  0
                    ? "red"
                    : "slate"
                }
              />
              <BreakdownTile
                label="Bounced"
                value={pipeline.notifications.bounced}
                tone={pipeline.notifications.bounced > 0 ? "red" : "slate"}
              />
            </div>
            <div className="border-t border-border/50 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[#64748b] mb-2">
                Stuck work
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2">
                  <Hourglass size={14} className="text-amber-600 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[11px] text-[#64748b]">
                      Pending enrichment
                    </p>
                    <p className="text-[15px] font-bold text-[#0f172a]">
                      {pipeline.pendingEnrichment}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2">
                  <MailX size={14} className="text-red-600 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[11px] text-[#64748b]">
                      Failed notifications
                    </p>
                    <p className="text-[15px] font-bold text-[#0f172a]">
                      {pipeline.notifications.failed}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Header({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]"
      style={{
        background:
          "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
        border: "1px solid rgba(46,55,254,0.2)",
        borderTop: "1px solid rgba(46,55,254,0.3)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
      }}
    >
      <div className="relative z-10 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[#64748b]">Operations</p>
          <h1
            className="text-[20px] sm:text-[22px] font-bold mt-1"
            style={{ color: "#0f172a", letterSpacing: "-0.01em" }}
          >
            Pipeline Health
          </h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            Live snapshot of the reply-routing pipeline — ingest, classification,
            notification, and auth.
          </p>
        </div>
        <button
          onClick={onRefresh}
          className="flex items-center gap-2 rounded-lg bg-white/60 px-3 py-2 text-sm font-medium text-[#0f172a] hover:bg-white/80 transition-colors"
        >
          <RefreshCw
            size={14}
            className={refreshing ? "animate-spin" : undefined}
          />
          Refresh
        </button>
      </div>
      <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
    </div>
  );
}

function BreakdownTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "amber" | "red" | "slate";
}) {
  const toneText: Record<typeof tone, string> = {
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    red: "text-red-700",
    slate: "text-[#0f172a]",
  } as const;
  return (
    <div className="rounded-lg border border-border/50 bg-white px-4 py-3">
      <p className="text-[11px] font-medium text-[#64748b]">{label}</p>
      <p
        className={`text-[22px] font-bold leading-tight mt-0.5 ${toneText[tone]}`}
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}
