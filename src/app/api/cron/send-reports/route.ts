import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { buildWeeklyReportEmail as buildWeeklyReportEmailHtml } from "@/lib/email/weekly-report";
import type { CampaignSnapshot, Client, Campaign, KPIReportData, KPIReport } from "@/types/app";

export async function POST(request: NextRequest) {
  const admin = createAdminClient();

  let body: Record<string, string> = {};
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

    // Get the client's email
    const { data: clientData } = await admin
      .from("clients")
      .select("*")
      .eq("id", report.client_id)
      .single();

    const client = clientData as unknown as Client | null;
    if (!client?.contact_email) {
      return NextResponse.json({ error: "Client has no contact email" }, { status: 400 });
    }

    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json({ error: "Email not configured (RESEND_API_KEY missing)" }, { status: 500 });
    }

    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);

      await resend.emails.send({
        from: process.env.EMAIL_FROM || "LeadStart <onboarding@resend.dev>",
        to: client.contact_email,
        subject: `Your Campaign Report — ${report.report_period_start} to ${report.report_period_end}`,
        html: buildWeeklyReportEmailHtml(report.report_data),
      });

      // Mark as sent
      await admin
        .from("kpi_reports")
        .update({
          sent_at: new Date().toISOString(),
          sent_to: [client.contact_email],
        })
        .eq("id", report.id);

      return NextResponse.json({ success: true, sent_to: client.contact_email });
    } catch (emailError) {
      console.error("Failed to send report:", emailError);
      return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
    }
  }

  // Mode 2: Generate and optionally send reports (cron/bulk mode)
  const clientId = body.client_id || null;
  const startDate = body.start_date || new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const endDate = body.end_date || new Date().toISOString().split("T")[0];

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
    const { data: campaignsData } = await admin
      .from("campaigns")
      .select("*")
      .eq("client_id", client.id);
    const campaigns = (campaignsData || []) as unknown as Campaign[];

    if (campaigns.length === 0) continue;

    const campaignIds = campaigns.map((c) => c.id);

    const { data: snapshotsData } = await admin
      .from("campaign_snapshots")
      .select("*")
      .in("campaign_id", campaignIds)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate);
    const snapshots = (snapshotsData || []) as unknown as CampaignSnapshot[];

    const campaignSummaries = campaigns.map((campaign) => {
      const campaignSnapshots = snapshots.filter(
        (s) => s.campaign_id === campaign.id
      );
      return {
        campaign_name: campaign.name,
        campaign_id: campaign.id,
        metrics: calculateMetrics(campaignSnapshots),
      };
    });

    const reportDataObj: KPIReportData = {
      client_name: client.name,
      period: { start: startDate, end: endDate },
      campaigns: campaignSummaries,
      totals: calculateMetrics(snapshots),
    };

    const { data: report } = await admin
      .from("kpi_reports")
      .insert({
        client_id: client.id,
        organization_id: client.organization_id,
        report_period_start: startDate,
        report_period_end: endDate,
        report_data: reportDataObj,
      })
      .select()
      .single();

    // Send email if client has contact email and Resend is configured
    if (client.contact_email && process.env.RESEND_API_KEY) {
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);

        await resend.emails.send({
          from: process.env.EMAIL_FROM || "LeadStart <onboarding@resend.dev>",
          to: client.contact_email,
          subject: `Your Campaign Report — ${startDate} to ${endDate}`,
          html: buildWeeklyReportEmailHtml(reportDataObj),
        });

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

    reports.push({ client: client.name, report_id: (report as Record<string, unknown> | null)?.id });
  }

  return NextResponse.json({ reports });
}
