import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { buildWeeklyReportEmail as buildReportHtml } from "@/lib/email/weekly-report";
import type { CampaignSnapshot, Client, Campaign, KPIReportData, KPIReport } from "@/types/app";

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

/** Send an email report via Resend */
async function sendReportEmail(
  reportData: KPIReportData,
  toEmails: string[],
  startDate: string,
  endDate: string
): Promise<void> {
  if (!process.env.RESEND_API_KEY || toEmails.length === 0) return;

  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);

  await resend.emails.send({
    from: process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>",
    to: toEmails,
    subject: `Your Campaign Report — ${startDate} to ${endDate}`,
    html: buildReportHtml(reportData),
  });
}

// ── GET: Vercel Cron (fires daily) ──────────────────────────────────────
// Checks each client's schedule. If due, generates a report for the
// trailing interval and sends to saved recipients.
export async function GET(request: NextRequest) {
  if (
    process.env.CRON_SECRET &&
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date();
  const results: { client: string; status: string }[] = [];

  // Get all clients with an active schedule
  const { data: clientsData } = await admin
    .from("clients")
    .select("*")
    .not("report_interval_days", "is", null)
    .gt("report_interval_days", 0);

  const clients = (clientsData || []) as unknown as Client[];

  for (const client of clients) {
    const intervalDays = client.report_interval_days!;
    const scheduleStart = client.report_schedule_start
      ? new Date(client.report_schedule_start)
      : null;

    // Determine if this client is due for a report
    let isDue = false;

    if (client.report_last_sent_at) {
      // Check if enough time has passed since last send
      const lastSent = new Date(client.report_last_sent_at);
      const daysSinceLast = (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60 * 24);
      isDue = daysSinceLast >= intervalDays;
    } else if (scheduleStart) {
      // Never sent before — check if we've passed the start date
      // and the current date aligns with the interval cadence
      const daysSinceStart = (now.getTime() - scheduleStart.getTime()) / (1000 * 60 * 60 * 24);
      isDue = daysSinceStart >= 0 && daysSinceStart % intervalDays < 1;
    } else {
      // Has interval but no start date and never sent — send now
      isDue = true;
    }

    if (!isDue) {
      results.push({ client: client.name, status: "not_due" });
      continue;
    }

    // Determine recipients
    const recipients = client.report_recipients && client.report_recipients.length > 0
      ? client.report_recipients
      : client.contact_email
        ? [client.contact_email]
        : [];

    if (recipients.length === 0) {
      results.push({ client: client.name, status: "no_recipients" });
      continue;
    }

    // Report covers the trailing interval
    const endDate = now.toISOString().split("T")[0];
    const startMs = now.getTime() - intervalDays * 24 * 60 * 60 * 1000;
    const startDate = new Date(startMs).toISOString().split("T")[0];

    try {
      const reportData = await generateReportData(admin, client, startDate, endDate);

      if (!reportData) {
        results.push({ client: client.name, status: "no_campaigns" });
        continue;
      }

      // Save report to DB
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

      // Send email
      await sendReportEmail(reportData, recipients, startDate, endDate);

      // Mark report as sent
      if (report) {
        await admin
          .from("kpi_reports")
          .update({ sent_at: now.toISOString(), sent_to: recipients })
          .eq("id", (report as Record<string, unknown>).id);
      }

      // Update last sent timestamp on client
      await admin
        .from("clients")
        .update({ report_last_sent_at: now.toISOString() })
        .eq("id", client.id);

      results.push({ client: client.name, status: "sent" });
    } catch (err) {
      console.error(`Failed to send report for ${client.name}:`, err);
      results.push({ client: client.name, status: "error" });
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
      await sendReportEmail(
        report.report_data,
        toEmails,
        report.report_period_start,
        report.report_period_end
      );

      await admin
        .from("kpi_reports")
        .update({ sent_at: new Date().toISOString(), sent_to: toEmails })
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
        await sendReportEmail(reportData, [client.contact_email], startDate, endDate);

        if (report) {
          await admin
            .from("kpi_reports")
            .update({
              sent_at: new Date().toISOString(),
              sent_to: [client.contact_email],
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
