// Daily heartbeat — proves the alert pipeline is alive.
//
// Sent every morning to every profile where role = 'owner'. The whole
// point is: if you stop seeing it, something is broken. The body is a
// small dashboard so a quick scan tells you whether yesterday went OK.
//
// What it monitors (in priority order):
//   1. Pending owner_alerts queue (should be ~0).
//   2. 24h send activity — reports + hot-leads.
//   3. Delivery confirmation gap — sends with sent_at stamped but
//      delivered_at still NULL after 30+ min. Strong proxy for
//      "RESEND_WEBHOOK_SECRET is wrong / webhook unregistered."
//   4. Stuck rows — orphan kpi_reports + lead_replies the retry cron
//      isn't picking up.
//   5. Schedule preview — what's due in the next 24h.
//   6. Config check — env presence + owner profile count.
//
// Robustness: each query is independent. A failure in one section
// shouldn't suppress the email — that would make the heartbeat itself
// unreliable, which is the failure mode we're trying to fix. Errors
// surface inline as "(query failed)" rather than throwing.

import type { createAdminClient } from "@/lib/supabase/admin";
import { isClientDueNow } from "@/lib/kpi/schedule";
import type { Client } from "@/types/app";

type AdminClient = ReturnType<typeof createAdminClient>;

export type HealthVerdict = "green" | "yellow" | "red";

export interface HeartbeatPayload {
  subject: string;
  html: string;
  verdict: HealthVerdict;
}

interface HeartbeatSections {
  pendingAlerts: { count: number; oldest: string | null; error: string | null };
  recentActivity: {
    reportsSent24h: number;
    hotLeadsSent24h: number;
    error: string | null;
  };
  deliveryGap: {
    reportsAwaitingConfirmation: number; // sent_at set, delivered_at null, sent >30min ago
    hotLeadsAwaitingConfirmation: number;
    reportsBounced24h: number;
    hotLeadsBounced24h: number;
    error: string | null;
  };
  stuck: {
    orphanReports: number; // sent_at NULL && created_at < now-1h
    stalledHotLeadRetries: number; // failed && retry_count<5 && last_attempt < now-30min
    error: string | null;
  };
  upcoming: { dueIn24h: Array<{ name: string; whenIso: string }>; error: string | null };
  config: {
    resendKeySet: boolean;
    resendWebhookSecretSet: boolean;
    cronSecretSet: boolean;
    ownerCount: number;
    error: string | null;
  };
}

/**
 * Build the heartbeat email payload. Runs all checks in parallel.
 * Returns subject, HTML body, and an overall verdict the cron can log.
 */
export async function buildHeartbeat(
  admin: AdminClient,
  now: Date = new Date(),
): Promise<HeartbeatPayload> {
  const [pendingAlerts, recentActivity, deliveryGap, stuck, upcoming, config] =
    await Promise.all([
      queryPendingAlerts(admin),
      queryRecentActivity(admin, now),
      queryDeliveryGap(admin, now),
      queryStuckRows(admin, now),
      queryUpcomingSchedule(admin, now),
      queryConfig(admin),
    ]);

  const sections: HeartbeatSections = {
    pendingAlerts,
    recentActivity,
    deliveryGap,
    stuck,
    upcoming,
    config,
  };
  const verdict = computeVerdict(sections);
  const subject = buildSubject(sections, verdict, now);
  const html = buildHtml(sections, verdict, now);
  return { subject, html, verdict };
}

// ── Verdict ─────────────────────────────────────────────────────────────

function computeVerdict(s: HeartbeatSections): HealthVerdict {
  // Red: anything that means alerts are broken or delivery confidence is gone.
  if (!s.config.resendKeySet) return "red";
  if (!s.config.resendWebhookSecretSet) return "red";
  if (s.config.ownerCount === 0) return "red";
  if (s.pendingAlerts.count > 10) return "red";
  if (s.deliveryGap.reportsAwaitingConfirmation > 5) return "red";

  // Yellow: signals that need a glance but aren't actively breaking.
  if (s.pendingAlerts.count > 0) return "yellow";
  if (s.deliveryGap.reportsAwaitingConfirmation > 0) return "yellow";
  if (s.deliveryGap.hotLeadsAwaitingConfirmation > 0) return "yellow";
  if (s.stuck.orphanReports > 0) return "yellow";
  if (s.stuck.stalledHotLeadRetries > 0) return "yellow";
  if (s.deliveryGap.reportsBounced24h + s.deliveryGap.hotLeadsBounced24h > 0) return "yellow";

  return "green";
}

// ── Queries ─────────────────────────────────────────────────────────────

async function queryPendingAlerts(
  admin: AdminClient,
): Promise<HeartbeatSections["pendingAlerts"]> {
  const { data, error, count } = await admin
    .from("owner_alerts")
    .select("created_at", { count: "exact" })
    .is("sent_at", null)
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    return { count: 0, oldest: null, error: error.message };
  }
  const oldest =
    (data?.[0] as { created_at?: string } | undefined)?.created_at ?? null;
  return { count: count ?? 0, oldest, error: null };
}

async function queryRecentActivity(
  admin: AdminClient,
  now: Date,
): Promise<HeartbeatSections["recentActivity"]> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [reports, hotLeads] = await Promise.all([
    admin
      .from("kpi_reports")
      .select("id", { count: "exact", head: true })
      .gte("sent_at", since),
    admin
      .from("lead_replies")
      .select("id", { count: "exact", head: true })
      .gte("notified_at", since),
  ]);

  if (reports.error || hotLeads.error) {
    return {
      reportsSent24h: 0,
      hotLeadsSent24h: 0,
      error:
        reports.error?.message ?? hotLeads.error?.message ?? "(unknown error)",
    };
  }
  return {
    reportsSent24h: reports.count ?? 0,
    hotLeadsSent24h: hotLeads.count ?? 0,
    error: null,
  };
}

async function queryDeliveryGap(
  admin: AdminClient,
  now: Date,
): Promise<HeartbeatSections["deliveryGap"]> {
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  // Resend usually fires email.delivered within seconds. 30 min is generous —
  // if the field is still NULL after that, the webhook is silent.
  const sentBefore = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

  const [
    reportsAwaiting,
    hotLeadsAwaiting,
    reportsBounced,
    hotLeadsBounced,
  ] = await Promise.all([
    admin
      .from("kpi_reports")
      .select("id", { count: "exact", head: true })
      .gte("sent_at", since24h)
      .lt("sent_at", sentBefore)
      .is("delivered_at", null)
      .is("bounced_at", null),
    admin
      .from("lead_replies")
      .select("id", { count: "exact", head: true })
      .gte("notified_at", since24h)
      .lt("notified_at", sentBefore)
      .is("notification_delivered_at", null)
      .is("notification_bounced_at", null),
    admin
      .from("kpi_reports")
      .select("id", { count: "exact", head: true })
      .gte("bounced_at", since24h),
    admin
      .from("lead_replies")
      .select("id", { count: "exact", head: true })
      .gte("notification_bounced_at", since24h),
  ]);

  const firstError =
    reportsAwaiting.error ??
    hotLeadsAwaiting.error ??
    reportsBounced.error ??
    hotLeadsBounced.error;
  if (firstError) {
    return {
      reportsAwaitingConfirmation: 0,
      hotLeadsAwaitingConfirmation: 0,
      reportsBounced24h: 0,
      hotLeadsBounced24h: 0,
      error: firstError.message,
    };
  }

  return {
    reportsAwaitingConfirmation: reportsAwaiting.count ?? 0,
    hotLeadsAwaitingConfirmation: hotLeadsAwaiting.count ?? 0,
    reportsBounced24h: reportsBounced.count ?? 0,
    hotLeadsBounced24h: hotLeadsBounced.count ?? 0,
    error: null,
  };
}

async function queryStuckRows(
  admin: AdminClient,
  now: Date,
): Promise<HeartbeatSections["stuck"]> {
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

  const [orphans, stalledRetries] = await Promise.all([
    admin
      .from("kpi_reports")
      .select("id", { count: "exact", head: true })
      .is("sent_at", null)
      .lt("created_at", oneHourAgo),
    admin
      .from("lead_replies")
      .select("id", { count: "exact", head: true })
      .eq("notification_status", "failed")
      .lt("notification_retry_count", 5)
      .lt("notification_last_attempt_at", thirtyMinAgo),
  ]);

  if (orphans.error || stalledRetries.error) {
    return {
      orphanReports: 0,
      stalledHotLeadRetries: 0,
      error:
        orphans.error?.message ??
        stalledRetries.error?.message ??
        "(unknown error)",
    };
  }
  return {
    orphanReports: orphans.count ?? 0,
    stalledHotLeadRetries: stalledRetries.count ?? 0,
    error: null,
  };
}

async function queryUpcomingSchedule(
  admin: AdminClient,
  now: Date,
): Promise<HeartbeatSections["upcoming"]> {
  const { data, error } = await admin
    .from("clients")
    .select("*")
    .not("report_frequency", "is", null);

  if (error) {
    return { dueIn24h: [], error: error.message };
  }

  const clients = (data ?? []) as unknown as Client[];
  const dueIn24h: Array<{ name: string; whenIso: string }> = [];
  // Walk hour-by-hour over the next 24h and ask isClientDueNow at each slot.
  // The cron itself runs hourly so this is the same predicate that decides
  // whether an actual send fires. Cheap (≤24*N evaluations).
  for (let h = 1; h <= 24; h++) {
    const at = new Date(now.getTime() + h * 60 * 60 * 1000);
    for (const c of clients) {
      const check = isClientDueNow(c, at);
      if (check.isDue) {
        dueIn24h.push({ name: c.name, whenIso: at.toISOString() });
      }
    }
  }
  // Dedup (client could match in two adjacent hours if isClientDueNow rounds);
  // keep first occurrence.
  const seen = new Set<string>();
  const deduped = dueIn24h.filter((d) => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    return true;
  });
  return { dueIn24h: deduped, error: null };
}

async function queryConfig(
  admin: AdminClient,
): Promise<HeartbeatSections["config"]> {
  const { count, error } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "owner");

  return {
    resendKeySet: !!process.env.RESEND_API_KEY,
    resendWebhookSecretSet: !!process.env.RESEND_WEBHOOK_SECRET,
    cronSecretSet: !!process.env.CRON_SECRET,
    ownerCount: count ?? 0,
    error: error?.message ?? null,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const VERDICT_LABEL: Record<HealthVerdict, string> = {
  green: "Healthy",
  yellow: "Needs a glance",
  red: "Action required",
};
const VERDICT_COLOR: Record<HealthVerdict, string> = {
  green: "#15803d",
  yellow: "#b45309",
  red: "#b91c1c",
};

function buildSubject(
  s: HeartbeatSections,
  verdict: HealthVerdict,
  now: Date,
): string {
  const dateStr = now.toISOString().split("T")[0];
  const tagline =
    verdict === "green"
      ? "all systems OK"
      : verdict === "yellow"
        ? `${countSignals(s)} signal${countSignals(s) === 1 ? "" : "s"}`
        : "action required";
  return `LeadStart status — ${dateStr} — ${tagline}`;
}

function countSignals(s: HeartbeatSections): number {
  let n = 0;
  if (s.pendingAlerts.count > 0) n++;
  if (s.deliveryGap.reportsAwaitingConfirmation > 0) n++;
  if (s.deliveryGap.hotLeadsAwaitingConfirmation > 0) n++;
  if (s.stuck.orphanReports > 0) n++;
  if (s.stuck.stalledHotLeadRetries > 0) n++;
  if (s.deliveryGap.reportsBounced24h + s.deliveryGap.hotLeadsBounced24h > 0)
    n++;
  return n;
}

function row(label: string, value: string, color = "#111"): string {
  return `<tr><td style="padding:4px 18px 4px 0;color:#555;font-size:13px;">${escapeHtml(label)}</td><td style="color:${color};font-size:13px;font-weight:500;">${value}</td></tr>`;
}

function check(value: boolean): string {
  return value
    ? `<span style="color:#15803d;">&#10003;</span>`
    : `<span style="color:#b91c1c;">&#10007;</span>`;
}

function buildHtml(
  s: HeartbeatSections,
  verdict: HealthVerdict,
  now: Date,
): string {
  const verdictLabel = VERDICT_LABEL[verdict];
  const verdictColor = VERDICT_COLOR[verdict];

  const sectionStyle =
    "margin:0 0 16px;padding:12px;border:1px solid #e5e7eb;border-radius:6px;";
  const h3 = (text: string) =>
    `<h3 style="margin:0 0 8px;font-size:14px;color:#111;">${escapeHtml(text)}</h3>`;
  const errLine = (err: string | null) =>
    err
      ? `<div style="color:#b91c1c;font-size:12px;margin-top:6px;">Query failed: ${escapeHtml(err)}</div>`
      : "";

  const oldestPending = s.pendingAlerts.oldest
    ? `<code>${escapeHtml(s.pendingAlerts.oldest)}</code>`
    : "—";

  const upcomingHtml = s.upcoming.dueIn24h.length
    ? `<ul style="margin:0;padding-left:20px;font-size:13px;">${s.upcoming.dueIn24h
        .map(
          (d) =>
            `<li>${escapeHtml(d.name)} — <code>${escapeHtml(d.whenIso)}</code></li>`,
        )
        .join("")}</ul>`
    : `<div style="font-size:13px;color:#555;">No reports scheduled in the next 24h.</div>`;

  const reportDeliveryColor =
    s.deliveryGap.reportsAwaitingConfirmation > 0 ? "#b45309" : "#111";
  const hotLeadDeliveryColor =
    s.deliveryGap.hotLeadsAwaitingConfirmation > 0 ? "#b45309" : "#111";
  const orphanColor = s.stuck.orphanReports > 0 ? "#b45309" : "#111";
  const stalledColor =
    s.stuck.stalledHotLeadRetries > 0 ? "#b45309" : "#111";

  return `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;max-width:680px;">
  <div style="margin:0 0 16px;padding:12px 16px;background:${verdictColor}10;border-left:4px solid ${verdictColor};border-radius:4px;">
    <div style="font-size:12px;color:${verdictColor};font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(verdictLabel)}</div>
    <div style="font-size:18px;font-weight:600;color:#111;margin-top:2px;">LeadStart system status</div>
    <div style="font-size:12px;color:#666;margin-top:2px;">${escapeHtml(now.toISOString())}</div>
  </div>

  <div style="${sectionStyle}">
    ${h3("Alert queue")}
    <table style="border-collapse:collapse;">
      ${row("Pending alerts", String(s.pendingAlerts.count), s.pendingAlerts.count > 0 ? "#b45309" : "#15803d")}
      ${row("Oldest pending", oldestPending)}
    </table>
    ${errLine(s.pendingAlerts.error)}
  </div>

  <div style="${sectionStyle}">
    ${h3("24h activity")}
    <table style="border-collapse:collapse;">
      ${row("Reports sent", String(s.recentActivity.reportsSent24h))}
      ${row("Hot-lead notifications sent", String(s.recentActivity.hotLeadsSent24h))}
    </table>
    ${errLine(s.recentActivity.error)}
  </div>

  <div style="${sectionStyle}">
    ${h3("Delivery confirmation (last 24h)")}
    <table style="border-collapse:collapse;">
      ${row("Reports awaiting confirmation (sent &gt;30min ago, no webhook event)", String(s.deliveryGap.reportsAwaitingConfirmation), reportDeliveryColor)}
      ${row("Hot-leads awaiting confirmation", String(s.deliveryGap.hotLeadsAwaitingConfirmation), hotLeadDeliveryColor)}
      ${row("Reports bounced", String(s.deliveryGap.reportsBounced24h), s.deliveryGap.reportsBounced24h > 0 ? "#b91c1c" : "#111")}
      ${row("Hot-leads bounced", String(s.deliveryGap.hotLeadsBounced24h), s.deliveryGap.hotLeadsBounced24h > 0 ? "#b91c1c" : "#111")}
    </table>
    <div style="font-size:12px;color:#666;margin-top:8px;">
      A persistent non-zero awaiting-confirmation count usually means
      <code>RESEND_WEBHOOK_SECRET</code> is wrong or the Resend webhook
      isn't registered.
    </div>
    ${errLine(s.deliveryGap.error)}
  </div>

  <div style="${sectionStyle}">
    ${h3("Stuck rows")}
    <table style="border-collapse:collapse;">
      ${row("Orphan kpi_reports (created &gt;1h ago, never sent)", String(s.stuck.orphanReports), orphanColor)}
      ${row("Stalled hot-lead retries (failed, awaiting cron pickup)", String(s.stuck.stalledHotLeadRetries), stalledColor)}
    </table>
    ${errLine(s.stuck.error)}
  </div>

  <div style="${sectionStyle}">
    ${h3("Reports due in the next 24h")}
    ${upcomingHtml}
    ${errLine(s.upcoming.error)}
  </div>

  <div style="${sectionStyle}">
    ${h3("Config check")}
    <table style="border-collapse:collapse;">
      <tr><td style="padding:4px 18px 4px 0;color:#555;font-size:13px;">RESEND_API_KEY</td><td>${check(s.config.resendKeySet)}</td></tr>
      <tr><td style="padding:4px 18px 4px 0;color:#555;font-size:13px;">RESEND_WEBHOOK_SECRET</td><td>${check(s.config.resendWebhookSecretSet)}</td></tr>
      <tr><td style="padding:4px 18px 4px 0;color:#555;font-size:13px;">CRON_SECRET</td><td>${check(s.config.cronSecretSet)}</td></tr>
      <tr><td style="padding:4px 18px 4px 0;color:#555;font-size:13px;">Owner profiles</td><td style="font-size:13px;font-weight:500;">${s.config.ownerCount}</td></tr>
    </table>
    ${errLine(s.config.error)}
  </div>

  <p style="margin:16px 0 0;color:#666;font-size:12px;">
    If you stop seeing this email, the alert system itself is broken.
    Investigate the <code>/api/cron/owner-heartbeat</code> Vercel cron logs.
  </p>
</div>`.trim();
}
