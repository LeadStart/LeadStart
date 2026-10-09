import type { KPIReportData } from "@/types/app";
import { EMAIL_FONT_STACK, EMAIL_FONT_HEAD } from "./brand";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// Absolute client-portal URL for the "View Full Dashboard" button.
// NEXT_PUBLIC_APP_URL already includes the /app basePath; fall back to prod so
// the button is never a dead "#" link (every scheduled report shipped one until
// 2026-10-09, because the send-reports cron never passed a URL).
function clientPortalUrl(): string {
  const base = (
    process.env.NEXT_PUBLIC_APP_URL || "https://leadstart-ebon.vercel.app/app"
  ).replace(/\/$/, "");
  return `${base}/client`;
}

// Cadence word for the header and <title>, from the length of the period the
// report covers rather than the client's setting, so a stored, resent or
// manual report is always labelled by what it actually covers. The
// send-reports cron spans 7 / 14 / 30 days for weekly / biweekly / monthly
// clients; the ±1 tolerance also fits an end-exclusive window, and 27-31 fits
// a manual calendar month. Any other range gets no cadence word.
export function reportCadence(period: { start: string; end: string }): "Weekly" | "Biweekly" | "Monthly" | null {
  const days = Math.round((Date.parse(period.end) - Date.parse(period.start)) / 86_400_000);
  if (days === 6 || days === 7) return "Weekly";
  if (days === 13 || days === 14) return "Biweekly";
  if (days >= 27 && days <= 31) return "Monthly";
  return null;
}

function formatPct(v: number): string {
  return v === 0 ? "0%" : `${v.toFixed(1)}%`;
}

interface KpiRow {
  label: string;
  value: number;
  // Context line under the label; null hides it (reports stored before
  // migration 00093 carry no new_leads_contacted).
  context: string | null;
  glyph: string;
  color: string;
  tint: string;
}

// One metric row of the KPI card ("Stacked Rows", picked from a 4-way mockup
// on 2026-10-09): icon chip, label + context line, big number on the right.
// Full-width rows mean nothing is squeezed three-across on a phone and no label
// wraps. The chip is a table cell, not a <div>, so Outlook keeps its size; the
// glyphs carry U+FE0E so iOS and Gmail draw them as text, not color emoji.
// Dividers sit on the text cells only, inset past the chip.
function kpiRow(m: KpiRow, first: boolean): string {
  const divider = first ? "" : " border-top: 1px solid #E2E3ED;";
  return `
                <tr>
                  <td width="50" valign="middle" style="width: 50px; padding: 14px 0 14px 16px; vertical-align: middle;">
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="34" height="34" align="center" valign="middle" style="width: 34px; height: 34px; background: ${m.tint}; border-radius: 10px; color: ${m.color}; font-size: 15px; font-weight: 700; text-align: center; vertical-align: middle;">${m.glyph}</td>
                      </tr>
                    </table>
                  </td>
                  <td valign="middle" style="padding: 14px 10px 14px 12px; vertical-align: middle;${divider}">
                    <p style="margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; color: #1A1A2E;">${m.label}</p>${
                      m.context
                        ? `
                    <p style="margin: 1px 0 0; font-size: 12px; line-height: 16px; color: #9194AD;">${m.context}</p>`
                        : ""
                    }
                  </td>
                  <td align="right" valign="middle" style="padding: 14px 18px 14px 0; text-align: right; vertical-align: middle;${divider}">
                    <p style="margin: 0; font-size: 26px; line-height: 30px; font-weight: 700; color: ${m.color}; letter-spacing: -0.5px; white-space: nowrap;">${m.value.toLocaleString()}</p>
                  </td>
                </tr>`;
}

const TH = "padding: 12px 8px; text-align: center; font-size: 11px; color: #6B6E8A; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;";
const TD = "padding: 14px 8px; border-bottom: 1px solid #E2E3ED; text-align: center; color: #3D3D5C;";

export function buildWeeklyReportEmail(data: KPIReportData, portalUrl: string = clientPortalUrl()): string {
  const cadence = reportCadence(data.period);
  const t = data.totals;
  const kpiRows: KpiRow[] = [
    {
      label: "Emails sent",
      value: t.emails_sent,
      context:
        typeof t.new_leads_contacted === "number"
          ? `${t.new_leads_contacted.toLocaleString()} new contacts`
          : null,
      glyph: "&#9993;&#xFE0E;",
      color: "#2E37FE",
      tint: "#EDEEFF",
    },
    {
      label: "Replies",
      value: t.replies,
      context: `${formatPct(t.reply_rate)} reply rate`,
      glyph: "&#8617;&#xFE0E;",
      color: "#7C3AED",
      tint: "#F5F3FF",
    },
    {
      label: "Positive responses",
      value: t.positive_replies,
      context: `${formatPct(t.positive_reply_rate)} of replies`,
      glyph: "&#10003;",
      color: "#059669",
      tint: "#ECFDF5",
    },
  ];

  const campaignRows = data.campaigns
    .map((c) => {
      return `
        <tr>
          <td style="padding: 14px 16px; border-bottom: 1px solid #E2E3ED; font-weight: 500; color: #1A1A2E;">
            ${c.campaign_name}
          </td>
          <td style="${TD}">
            ${c.metrics.emails_sent.toLocaleString()}
          </td>
          <td style="${TD}">
            ${c.metrics.replies.toLocaleString()}
          </td>
          <td style="${TD} font-weight: 600;">
            ${c.metrics.positive_replies.toLocaleString()}
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
  <title>${cadence ? `${cadence} ` : ""}Campaign Report: ${data.client_name}</title>
  ${EMAIL_FONT_HEAD}
</head>
<body style="margin: 0; padding: 0; background-color: #F4F5F9; font-family: ${EMAIL_FONT_STACK}; -webkit-font-smoothing: antialiased;">

  <!-- Wrapper -->
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F4F5F9;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%;">

          <!-- Header Banner -->
          <tr>
            <td style="background: #2E37FE; border-radius: 16px 16px 0 0; padding: 36px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="background: #4D55FE; border-radius: 8px; width: 36px; height: 36px; text-align: center; vertical-align: middle;">
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
                    <p style="margin: 0; color: #C0C3FF; font-size: 13px; text-transform: uppercase; letter-spacing: 1px;">
                      ${cadence ?? "Campaign"} Performance Report
                    </p>
                    <h1 style="margin: 6px 0 0; color: #ffffff; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">
                      ${data.client_name}
                    </h1>
                    <p style="margin: 8px 0 0; color: #ABAFFF; font-size: 14px;">
                      ${formatDate(data.period.start)} to ${formatDate(data.period.end)}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- KPI Summary -->
          <tr>
            <td style="background: #ffffff; padding: 28px 24px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #E2E3ED; border-radius: 14px; border-collapse: separate;">${kpiRows
                .map((m, i) => kpiRow(m, i === 0))
                .join("")}
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
                  <tr style="background: #EDEEFF;">
                    <th style="padding: 12px 16px; text-align: left; font-size: 11px; color: #6B6E8A; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                      Campaign
                    </th>
                    <th style="${TH}">
                      Sent
                    </th>
                    <th style="${TH}">
                      Replies
                    </th>
                    <th style="${TH}">
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
              <a href="${portalUrl}" style="display: inline-block; background: #2E37FE; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-size: 14px; font-weight: 600; letter-spacing: -0.2px;">
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
