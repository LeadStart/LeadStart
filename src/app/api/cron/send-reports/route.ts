import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { buildWeeklyReportEmail as buildWeeklyReportEmailHtml } from "@/lib/email/weekly-report";
import type { CampaignSnapshot, Client, Campaign, KPIReportData } from "@/types/app";

export async function POST(request: NextRequest) {
  const admin = createAdminClient();

  let clientId: string | null = null;
  let startDate: string;
  let endDate: string;

  try {
    const body = await request.json();
    clientId = body.client_id || null;
    startDate = body.start_date;
    endDate = body.end_date;
  } catch {
    // Default to last 7 days
    endDate = new Date().toISOString().split("T")[0];
    startDate = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  }

  // Get clients to report on
  let clients: Client[];
  if (clientId) {
    const { data } = await admin
      .from("clients")
      .select("*")
      .eq("id", clientId);
    clients = (data || []) as Client[];
  } else {
    const { data } = await admin.from("clients").select("*");
    clients = (data || []) as Client[];
  }

  const reports = [];

  for (const client of clients) {
    // Get campaigns for this client
    const { data: campaignsData } = await admin
      .from("campaigns")
      .select("*")
      .eq("client_id", client.id);
    const campaigns = (campaignsData || []) as Campaign[];

    if (campaigns.length === 0) continue;

    const campaignIds = campaigns.map((c) => c.id);

    // Get snapshots for the date range
    const { data: snapshotsData } = await admin
      .from("campaign_snapshots")
      .select("*")
      .in("campaign_id", campaignIds)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate);
    const snapshots = (snapshotsData || []) as CampaignSnapshot[];

    // Build per-campaign summaries
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

    const reportData: KPIReportData = {
      client_name: client.name,
      period: { start: startDate, end: endDate },
      campaigns: campaignSummaries,
      totals: calculateMetrics(snapshots),
    };

    // Store the report
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

    // Send email if client has contact email and Resend is configured
    if (client.contact_email && process.env.RESEND_API_KEY) {
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);

        await resend.emails.send({
          from: process.env.EMAIL_FROM || "LeadStart <reports@leadstart.com>",
          to: client.contact_email,
          subject: `Your Weekly Campaign Report — ${startDate} to ${endDate}`,
          html: buildWeeklyReportEmailHtml(reportData),
        });

        // Mark as sent
        if (report) {
          await admin
            .from("kpi_reports")
            .update({
              sent_at: new Date().toISOString(),
              sent_to: [client.contact_email],
            })
            .eq("id", report.id);
        }
      } catch (emailError) {
        console.error(`Failed to send report to ${client.contact_email}:`, emailError);
      }
    }

    reports.push({ client: client.name, report_id: report?.id });
  }

  return NextResponse.json({ reports });
}

