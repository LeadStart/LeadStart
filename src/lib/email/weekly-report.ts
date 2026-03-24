import type { KPIReportData } from "@/types/app";

function healthColor(rate: number, goodThreshold: number, direction: "higher" | "lower"): string {
  if (direction === "higher") {
    return rate >= goodThreshold ? "#10b981" : rate >= goodThreshold * 0.6 ? "#f59e0b" : "#ef4444";
  }
  return rate <= goodThreshold ? "#10b981" : rate <= goodThreshold * 2 ? "#f59e0b" : "#ef4444";
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function buildWeeklyReportEmail(data: KPIReportData, portalUrl?: string): string {
  const replyColor = healthColor(data.totals.reply_rate, 5, "higher");
  const bounceColor = healthColor(data.totals.bounce_rate, 2, "lower");
  const positiveColor = healthColor(data.totals.positive_reply_rate, 30, "higher");

  const campaignRows = data.campaigns
    .map((c) => {
      const rColor = healthColor(c.metrics.reply_rate, 5, "higher");
      const bColor = healthColor(c.metrics.bounce_rate, 2, "lower");
      return `
        <tr>
          <td style="padding: 14px 16px; border-bottom: 1px solid #f0f0f5; font-weight: 500; color: #1a1a2e;">
            ${c.campaign_name}
          </td>
          <td style="padding: 14px 16px; border-bottom: 1px solid #f0f0f5; text-align: center; color: #374151;">
            ${c.metrics.emails_sent.toLocaleString()}
          </td>
          <td style="padding: 14px 16px; border-bottom: 1px solid #f0f0f5; text-align: center; font-weight: 600; color: ${rColor};">
            ${c.metrics.reply_rate}%
          </td>
          <td style="padding: 14px 16px; border-bottom: 1px solid #f0f0f5; text-align: center; color: ${bColor};">
            ${c.metrics.bounce_rate}%
          </td>
          <td style="padding: 14px 16px; border-bottom: 1px solid #f0f0f5; text-align: center; font-weight: 600; color: #374151;">
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
<body style="margin: 0; padding: 0; background-color: #f4f4f8; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased;">

  <!-- Wrapper -->
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f4f8;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%;">

          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1); border-radius: 16px 16px 0 0; padding: 36px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="background: rgba(255,255,255,0.15); border-radius: 8px; width: 36px; height: 36px; text-align: center; vertical-align: middle;">
                          <span style="color: #fff; font-size: 16px;">&#9993;</span>
                        </td>
                        <td style="padding-left: 12px; color: #fff; font-size: 18px; font-weight: 700; letter-spacing: -0.3px;">
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
                    <h1 style="margin: 6px 0 0; color: #fff; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">
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
            <td style="background: #fff; padding: 28px 24px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td width="25%" style="padding: 0 4px;">
                    <div style="background: #f0f0ff; border-radius: 12px; padding: 16px; text-align: center;">
                      <p style="margin: 0; font-size: 24px; font-weight: 700; color: #4f46e5;">
                        ${data.totals.emails_sent.toLocaleString()}
                      </p>
                      <p style="margin: 4px 0 0; font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">
                        Emails Sent
                      </p>
                    </div>
                  </td>
                  <td width="25%" style="padding: 0 4px;">
                    <div style="background: ${replyColor}11; border-radius: 12px; padding: 16px; text-align: center;">
                      <p style="margin: 0; font-size: 24px; font-weight: 700; color: ${replyColor};">
                        ${data.totals.reply_rate}%
                      </p>
                      <p style="margin: 4px 0 0; font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">
                        Reply Rate
                      </p>
                    </div>
                  </td>
                  <td width="25%" style="padding: 0 4px;">
                    <div style="background: #fef3c711; border-radius: 12px; padding: 16px; text-align: center;">
                      <p style="margin: 0; font-size: 24px; font-weight: 700; color: #374151;">
                        ${data.totals.meetings_booked}
                      </p>
                      <p style="margin: 4px 0 0; font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">
                        Meetings
                      </p>
                    </div>
                  </td>
                  <td width="25%" style="padding: 0 4px;">
                    <div style="background: ${positiveColor}11; border-radius: 12px; padding: 16px; text-align: center;">
                      <p style="margin: 0; font-size: 24px; font-weight: 700; color: ${positiveColor};">
                        ${data.totals.positive_reply_rate}%
                      </p>
                      <p style="margin: 4px 0 0; font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">
                        Positive Rate
                      </p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Secondary Metrics -->
          <tr>
            <td style="background: #fff; padding: 12px 24px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td width="33%" style="padding: 0 4px;">
                    <div style="border: 1px solid #f0f0f5; border-radius: 10px; padding: 14px; text-align: center;">
                      <p style="margin: 0; font-size: 18px; font-weight: 700; color: ${bounceColor};">
                        ${data.totals.bounce_rate}%
                      </p>
                      <p style="margin: 2px 0 0; font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">
                        Bounce Rate
                      </p>
                    </div>
                  </td>
                  <td width="33%" style="padding: 0 4px;">
                    <div style="border: 1px solid #f0f0f5; border-radius: 10px; padding: 14px; text-align: center;">
                      <p style="margin: 0; font-size: 18px; font-weight: 700; color: #374151;">
                        ${data.totals.unsubscribe_rate}%
                      </p>
                      <p style="margin: 2px 0 0; font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">
                        Unsub Rate
                      </p>
                    </div>
                  </td>
                  <td width="33%" style="padding: 0 4px;">
                    <div style="border: 1px solid #f0f0f5; border-radius: 10px; padding: 14px; text-align: center;">
                      <p style="margin: 0; font-size: 18px; font-weight: 700; color: #374151;">
                        ${data.totals.reply_to_meeting_rate}%
                      </p>
                      <p style="margin: 2px 0 0; font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">
                        Reply &#8594; Meeting
                      </p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Campaign Breakdown -->
          <tr>
            <td style="background: #fff; padding: 0 24px 28px;">
              <h2 style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #1a1a2e; padding-top: 20px; border-top: 1px solid #f0f0f5;">
                Campaign Breakdown
              </h2>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #f0f0f5; border-radius: 10px; overflow: hidden;">
                <thead>
                  <tr style="background: #f8f8fc;">
                    <th style="padding: 12px 16px; text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                      Campaign
                    </th>
                    <th style="padding: 12px 16px; text-align: center; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                      Sent
                    </th>
                    <th style="padding: 12px 16px; text-align: center; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                      Reply %
                    </th>
                    <th style="padding: 12px 16px; text-align: center; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                      Bounce %
                    </th>
                    <th style="padding: 12px 16px; text-align: center; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                      Meetings
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
            <td style="background: #fff; padding: 0 24px 32px; text-align: center;">
              <a href="${portalUrl || '#'}" style="display: inline-block; background: linear-gradient(135deg, #4f46e5, #7c3aed); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-size: 14px; font-weight: 600; letter-spacing: -0.2px;">
                View Full Dashboard &#8594;
              </a>
              <p style="margin: 12px 0 0; font-size: 13px; color: #9ca3af;">
                Log in to see detailed charts, submit lead feedback, and more.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #fff; border-radius: 0 0 16px 16px; padding: 20px 24px; border-top: 1px solid #f0f0f5;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                      Sent by <strong style="color: #6b7280;">LeadStart</strong> &middot; Campaign Management Platform
                    </p>
                    <p style="margin: 4px 0 0; font-size: 11px; color: #c4c4cc;">
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
