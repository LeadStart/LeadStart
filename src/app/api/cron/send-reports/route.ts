import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { buildWeeklyReportEmail as buildReportHtml } from "@/lib/email/weekly-report";
import { sendViaResend } from "@/lib/notifications/resend-client";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import { isClientDueNow } from "@/lib/kpi/schedule";
import type { CampaignSnapshot, Client, Campaign, KPIReportData, KPIReport } from "@/types/app";

// Map frequency → period covered by the emailed report
function reportPeriodDays(frequency: Client["report_frequency"]): number {
  if (frequency === "biweekly") return 14;
  if (frequency === "monthly") return 30;
  return 7;
}

/** Shared helper: generate report data for a client + date range */
async function generateReportData(
  admin: ReturnType<typeof createAdminClient>,
  client: Client,
  startDate: string,
  endDate: string
): Promise<KPIReportData | null> {
  const { data: campaignsData } = await admin
    .from("campaigns")
    .select("*")
    .eq("client_id", client.id);
  const campaigns = (campaignsData || []) as unknown as Campaign[];

  if (campaigns.length === 0) return null;

  const campaignIds = campaigns.map((c) => c.id);
  const { data: snapshotsData } = await admin
    .from("campaign_snapshots")
    .select("*")
    .in("campaign_id", campaignIds)
    .gte("snapshot_date", startDate)
    .lte("snapshot_date", endDate);
  const snapshots = (snapshotsData || []) as unknown as CampaignSnapshot[];

  const campaignSummaries = campaigns
    .map((campaign) => {
      const campSnaps = snapshots.filter((s) => s.campaign_id === campaign.id);
      return {
        campaign_name: campaign.name,
        campaign_id: campaign.id,
        metrics: calculateMetrics(campSnaps),
      };
    })
    .filter((c) => c.metrics.emails_sent > 0);

  return {
    client_name: client.name,
    period: { start: startDate, end: endDate },
    campaigns: campaignSummaries,
    totals: calculateMetrics(snapshots),
  };
}

/** Send an email report via the throttled Resend wrapper.
 *  Throws on missing API key so the caller's catch block records a real error
 *  (prevents the "ghost sent" case where sent_at was stamped but nothing shipped).
 *  Returns the Resend message id so the caller can store it on the kpi_reports
 *  row — the Resend webhook needs that id to correlate delivery/bounce events. */
async function sendReportEmail(
  reportData: KPIReportData,
  toEmails: string[],
  startDate: string,
  endDate: string
): Promise<{ resendId: string | null }> {
  if (toEmails.length === 0) {
    throw new Error("No recipients provided");
  }
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not set — cannot send report email");
  }

  // Weekly KPI reports don't use the hot-lead retry queue — a failed report
  // is low-urgency and the next-hour cron rerun catches most transient drops.
  // The throttle is still valuable to avoid bursts when a scheduled run
  // sends to many clients at once.
  const result = await sendViaResend({
    from: process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>",
    to: toEmails,
    subject: `Your Campaign Report — ${startDate} to ${endDate}`,
    html: buildReportHtml(reportData),
  });
  return { resendId: result.id };
}

// ── GET: Vercel Cron (fires hourly) ─────────────────────────────────────
// Checks each client's fixed day/time schedule in their configured timezone.
// If the current hour matches AND the current day matches per frequency rule
// (weekly / biweekly / monthly), generates a trailing-period report and sends
// to saved recipients.
export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const now = new Date();
  const results: { client: string; status: string; reason?: string }[] = [];

  // Get all clients with an active fixed schedule
  const { data: clientsData } = await admin
    .from("clients")
    .select("*")
    .not("report_frequency", "is", null);

  const clients = (clientsData || []) as unknown as Client[];

  for (const client of clients) {
    const check = isClientDueNow(client, now);
    if (!check.isDue) {
      results.push({ client: client.name, status: "not_due", reason: check.reason });
      continue;
    }

    const recipients = client.report_recipients && client.report_recipients.length > 0
      ? client.report_recipients
      : client.contact_email
        ? [client.contact_email]
        : [];

    if (recipients.length === 0) {
      results.push({ client: client.name, status: "no_recipients" });
      continue;
    }

    // Report covers the trailing period matching the frequency
    const periodDays = reportPeriodDays(client.report_frequency);
    const endDate = now.toISOString().split("T")[0];
    const startMs = now.getTime() - periodDays * 24 * 60 * 60 * 1000;
    const startDate = new Date(startMs).toISOString().split("T")[0];

    try {
      const reportData = await generateReportData(admin, client, startDate, endDate);

      if (!reportData) {
        results.push({ client: client.name, status: "no_campaigns" });
        continue;
      }

      const { data: report } = await admin
        .from("kpi_reports")
        .insert({
          client_id: client.id,
          organization_id: client.organization_id,
          report_period_start: startDate,
          report_period_end: endDate,
          report_data: reportData,
        })
        .select()
        .single();

      // If sendReportEmail throws (Resend rejection, bad key, etc.) we fall
      // through to the catch block and DO NOT stamp sent_at / last_sent_at.
      // That's what makes a next-hour retry possible and keeps the client's
      // schedule unblocked.
      const { resendId } = await sendReportEmail(reportData, recipients, startDate, endDate);

      if (report) {
        await admin
          .from("kpi_reports")
          .update({
            sent_at: now.toISOString(),
            sent_to: recipients,
            resend_email_id: resendId,
          })
          .eq("id", (report as Record<string, unknown>).id);
      }

      await admin
        .from("clients")
        .update({ report_last_sent_at: now.toISOString() })
        .eq("id", client.id);

      results.push({ client: client.name, status: "sent" });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Failed to send report for ${client.name}:`, err);
      // Persistent failure: every cron throw bypasses the silent next-hour
      // retry by surfacing in the owner digest. Soft Resend errors classify
      // as TransientResendError and don't reach here — they throw before
      // sendReportEmail returns and we don't have a separate transient
      // bucket for reports today.
      await enqueueOwnerAlert({
        admin,
        kind: "report_send_error",
        subject: `Report send failed for ${client.name}`,
        summary: `KPI report cron failed for ${client.name}: ${errorMessage}`,
        context: {
          client_id: client.id,
          client_name: client.name,
          recipients: recipients.join(", "),
          period: `${startDate} → ${endDate}`,
          error: errorMessage,
        },
      });
      results.push({
        client: client.name,
        status: "error",
        reason: errorMessage,
      });
    }
  }

  return NextResponse.json({ results });
}

// ── POST: Manual send from admin UI ─────────────────────────────────────
export async function POST(request: NextRequest) {
  const admin = createAdminClient();

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // empty body is ok
  }

  // Mode 1: Send an existing report by ID
  if (body.reportId) {
    const { data: reportData } = await admin
      .from("kpi_reports")
      .select("*")
      .eq("id", body.reportId)
      .single();

    if (!reportData) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    const report = reportData as unknown as KPIReport;

    // Determine recipients
    let toEmails: string[] = [];
    if (Array.isArray(body.recipients) && (body.recipients as string[]).length > 0) {
      toEmails = body.recipients as string[];
    } else {
      const { data: clientData } = await admin
        .from("clients")
        .select("*")
        .eq("id", report.client_id)
        .single();
      const client = clientData as unknown as Client | null;
      if (!client?.contact_email) {
        return NextResponse.json(
          { error: "No recipients selected and client has no contact email" },
          { status: 400 }
        );
      }
      toEmails = [client.contact_email];
    }

    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json(
        { error: "Email not configured (RESEND_API_KEY missing)" },
        { status: 500 }
      );
    }

    try {
      const { resendId } = await sendReportEmail(
        report.report_data,
        toEmails,
        report.report_period_start,
        report.report_period_end
      );

      await admin
        .from("kpi_reports")
        .update({
          sent_at: new Date().toISOString(),
          sent_to: toEmails,
          resend_email_id: resendId,
        })
        .eq("id", report.id);

      return NextResponse.json({ success: true, sent_to: toEmails });
    } catch (emailError) {
      console.error("Failed to send report:", emailError);
      return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
    }
  }

  // Mode 2: Generate and send reports (bulk mode)
  const clientId = body.client_id as string | null;
  const startDate =
    (body.start_date as string) ||
    new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const endDate = (body.end_date as string) || new Date().toISOString().split("T")[0];

  let clients: Client[];
  if (clientId) {
    const { data } = await admin.from("clients").select("*").eq("id", clientId);
    clients = (data || []) as unknown as Client[];
  } else {
    const { data } = await admin.from("clients").select("*");
    clients = (data || []) as unknown as Client[];
  }

  const reports = [];

  for (const client of clients) {
    const reportData = await generateReportData(admin, client, startDate, endDate);
    if (!reportData) continue;

    const { data: report } = await admin
      .from("kpi_reports")
      .insert({
        client_id: client.id,
        organization_id: client.organization_id,
        report_period_start: startDate,
        report_period_end: endDate,
        report_data: reportData,
      })
      .select()
      .single();

    if (client.contact_email && process.env.RESEND_API_KEY) {
      try {
        const { resendId } = await sendReportEmail(
          reportData,
          [client.contact_email],
          startDate,
          endDate
        );

        if (report) {
          await admin
            .from("kpi_reports")
            .update({
              sent_at: new Date().toISOString(),
              sent_to: [client.contact_email],
              resend_email_id: resendId,
            })
            .eq("id", (report as Record<string, unknown>).id);
        }
      } catch (emailError) {
        console.error(`Failed to send report to ${client.contact_email}:`, emailError);
      }
    }

    reports.push({
      client: client.name,
      report_id: (report as Record<string, unknown> | null)?.id,
    });
  }

  return NextResponse.json({ reports });
}
