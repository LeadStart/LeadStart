import type { KPIReportData } from "@/types/app";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function buildWeeklyReportEmail(data: KPIReportData, portalUrl?: string): string {
  const campaignRows = data.campaigns
    .map((c) => {
      return `
        <tr>
          <td style="padding: 14px 16px; border-bottom: 1px solid #E2E3ED; font-weight: 500; color: #1A1A2E;">
            ${c.campaign_name}
          </td>
          <td style="padding: 14px 16px; border-bottom: 1px solid #E2E3ED; text-align: center; color: #3D3D5C;">
            ${c.metrics.emails_sent.toLocaleString()}
          </td>
          <td style="padding: 14px 16px; border-bottom: 1px solid #E2E3ED; text-align: center; font-weight: 600; color: #3D3D5C;">
            ${c.metrics.meetings_booked}
          </td>
        </tr>`;
    })
    .join("");

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Campaign Report — ${data.client_name}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F4F5F9; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased;">

  <!-- Wrapper -->
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F4F5F9;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%;">

          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #6B72FF 0%, #2E37FE 30%, #1C24B8 65%, #0F1880 100%); border-radius: 16px 16px 0 0; padding: 36px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="background: rgba(255,255,255,0.15); border-radius: 8px; width: 36px; height: 36px; text-align: center; vertical-align: middle;">
                          <span style="color: #ffffff; font-size: 16px;">&#9993;</span>
                        </td>
                        <td style="padding-left: 12px; color: #ffffff; font-size: 18px; font-weight: 700; letter-spacing: -0.3px;">
                          LeadStart
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding-top: 20px;">
                    <p style="margin: 0; color: rgba(255,255,255,0.7); font-size: 13px; text-transform: uppercase; letter-spacing: 1px;">
                      Weekly Performance Report
                    </p>
                    <h1 style="margin: 6px 0 0; color: #ffffff; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">
                      ${data.client_name}
                    </h1>
                    <p style="margin: 8px 0 0; color: rgba(255,255,255,0.6); font-size: 14px;">
                      ${formatDate(data.period.start)} — ${formatDate(data.period.end)}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- KPI Summary Cards -->
          <tr>
            <td style="background: #ffffff; padding: 28px 24px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td width="50%" style="padding: 0 6px;">
                    <div style="background: #EDEEFF; border: 1px solid #D1D3FF; border-radius: 12px; padding: 20px; text-align: center;">
                      <p style="margin: 0; font-size: 32px; font-weight: 700; color: #2E37FE;">
                        ${data.totals.emails_sent.toLocaleString()}
                      </p>
                      <p style="margin: 6px 0 0; font-size: 11px; color: #6B6E8A; text-transform: uppercase; letter-spacing: 0.5px;">
                        Emails Sent
                      </p>
                    </div>
                  </td>
                  <td width="50%" style="padding: 0 6px;">
                    <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 12px; padding: 20px; text-align: center;">
                      <p style="margin: 0; font-size: 32px; font-weight: 700; color: #10b981;">
                        ${data.totals.meetings_booked}
                      </p>
                      <p style="margin: 6px 0 0; font-size: 11px; color: #6B6E8A; text-transform: uppercase; letter-spacing: 0.5px;">
                        Positive Responses
                      </p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Campaign Breakdown -->
          <tr>
            <td style="background: #ffffff; padding: 0 24px 28px;">
              <h2 style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #1A1A2E; padding-top: 20px; border-top: 1px solid #E2E3ED;">
                Campaign Breakdown
              </h2>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #E2E3ED; border-radius: 10px; overflow: hidden;">
                <thead>
                  <tr style="background: linear-gradient(180deg, #D1D3FF 0%, #EDEEFF 100%);">
                    <th style="padding: 12px 16px; text-align: left; font-size: 11px; color: #6B6E8A; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                      Campaign
                    </th>
                    <th style="padding: 12px 16px; text-align: center; font-size: 11px; color: #6B6E8A; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                      Sent
                    </th>
                    <th style="padding: 12px 16px; text-align: center; font-size: 11px; color: #6B6E8A; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                      Positive Responses
                    </th>
                  </tr>
                </thead>
                <tbody>
                  ${campaignRows}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="background: #ffffff; padding: 0 24px 32px; text-align: center;">
              <a href="${portalUrl || '#'}" style="display: inline-block; background: linear-gradient(135deg, #6B72FF, #2E37FE); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-size: 14px; font-weight: 600; letter-spacing: -0.2px;">
                View Full Dashboard &#8594;
              </a>
              <p style="margin: 12px 0 0; font-size: 13px; color: #6B6E8A;">
                Log in to see detailed charts, submit lead feedback, and more.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #ffffff; border-radius: 0 0 16px 16px; padding: 20px 24px; border-top: 1px solid #E2E3ED;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <p style="margin: 0; font-size: 12px; color: #6B6E8A;">
                      Sent by <strong style="color: #1A1A2E;">LeadStart</strong> &middot; Campaign Management Platform
                    </p>
                    <p style="margin: 4px 0 0; font-size: 11px; color: #9194AD;">
                      This report was generated automatically. Reply to this email with any questions.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}
