// Hot-lead notification email to clients.notification_email.
//
// Shape matches src/lib/email/* — plain HTML string template, inline
// styles, table-based layout for broad mail-client compatibility.
// Returns both subject and html so the orchestrator doesn't have to
// reconstruct the subject from the same fields.

import type { ReplyClass } from "@/types/app";

export interface ClientNotificationEmailData {
  leadName: string | null;
  leadCompany: string | null;
  leadPhone: string | null;       // already-formatted E.164 or pretty; we display as-is
  classLabel: string;              // human-readable from classLabelFor(final_class)
  replyBodyPreview: string;        // truncated to ~400 chars in orchestrator
  dossierUrl: string;              // absolute URL with ?token=... — single-use, 4h TTL
  portalUrl: string;               // absolute URL, no token — permanent, requires login
  receivedAt: string;              // ISO — rendered as "just now" / "X min ago" by reader's client; we display formatted
}

export interface BuiltClientNotificationEmail {
  subject: string;
  html: string;
}

// Short, human-readable labels for subjects + body. Mirrors the taxonomy in
// docs/plans/ai-reply-routing.md. Anything not listed falls back to the raw
// class name with underscores → spaces.
const CLASS_LABELS: Partial<Record<ReplyClass, string>> = {
  true_interest: "Interested",
  meeting_booked: "Meeting booked",
  qualifying_question: "Qualifying question",
  referral_forward: "Referral",
  objection_price: "Price objection",
  objection_timing: "Timing objection",
};

export function classLabelFor(cls: ReplyClass | string | null | undefined): string {
  if (!cls) return "Hot reply";
  const mapped = CLASS_LABELS[cls as ReplyClass];
  if (mapped) return mapped;
  return cls.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatReceivedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

// tel: URI — strip everything except + and digits so the phone app gets a
// clean target even if the display format has parens, dashes, spaces.
function telUri(phone: string): string {
  const cleaned = phone.replace(/[^+\d]/g, "");
  return `tel:${cleaned}`;
}

export function buildClientNotificationEmail(
  data: ClientNotificationEmailData
): BuiltClientNotificationEmail {
  const leadName = data.leadName?.trim() || "A new lead";
  const leadCompany = data.leadCompany?.trim() || "";
  const companyFragment = leadCompany ? ` @ ${leadCompany}` : "";

  // Generic subject — class-specific labels live on the row + UI badge for
  // organization, but the email itself stays uniform per owner request.
  const subject = `🔔 New hot lead reply — ${leadName}${companyFragment}`;

  const phoneBlock = data.leadPhone
    ? `
            <tr>
              <td style="padding: 24px 32px 0;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 14px; padding: 22px; text-align: center;">
                  <p style="margin: 0 0 6px; font-size: 11px; color: rgba(255,255,255,0.85); text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">
                    Call now
                  </p>
                  <a href="${telUri(data.leadPhone)}" style="display: inline-block; color: #ffffff; font-size: 28px; font-weight: 700; text-decoration: none; letter-spacing: -0.5px;">
                    📞 ${escapeHtml(data.leadPhone)}
                  </a>
                </div>
              </td>
            </tr>`
    : `
            <tr>
              <td style="padding: 24px 32px 0;">
                <div style="background: #FEF3C7; border: 1px solid #FCD34D; border-radius: 10px; padding: 14px 16px;">
                  <p style="margin: 0; font-size: 13px; color: #92400E;">
                    No phone number on file — view the full reply to respond by email.
                  </p>
                </div>
              </td>
            </tr>`;

  const receivedAtText = formatReceivedAt(data.receivedAt);

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F4F5F9; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F4F5F9;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%;">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #6B72FF 0%, #2E37FE 30%, #1C24B8 65%, #0F1880 100%); border-radius: 16px 16px 0 0; padding: 28px 32px;">
              <p style="margin: 0; color: rgba(255,255,255,0.75); font-size: 12px; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 600;">
                🔔 Hot lead
              </p>
              <h1 style="margin: 8px 0 4px; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.4px;">
                ${escapeHtml(leadName)}${leadCompany ? ` <span style="color: rgba(255,255,255,0.7); font-weight: 500;">@ ${escapeHtml(leadCompany)}</span>` : ""}
              </h1>
              <p style="margin: 6px 0 0; color: rgba(255,255,255,0.7); font-size: 13px;">
                A hot lead just replied. Call them now — every minute matters.
              </p>
            </td>
          </tr>

          <!-- Phone / no-phone block -->
          ${phoneBlock}

          <!-- Reply preview -->
          <tr>
            <td style="background: #ffffff; padding: 24px 32px 8px;">
              <p style="margin: 0 0 10px; font-size: 11px; color: #6B6E8A; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 600;">
                Their reply${receivedAtText ? ` · ${escapeHtml(receivedAtText)}` : ""}
              </p>
              <div style="background: #F4F5F9; border-left: 3px solid #2E37FE; border-radius: 0 8px 8px 0; padding: 14px 16px; font-size: 14px; color: #1A1A2E; line-height: 1.55; white-space: pre-wrap;">
${escapeHtml(data.replyBodyPreview)}
              </div>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="background: #ffffff; padding: 20px 32px 28px; text-align: center;">
              <a href="${data.dossierUrl}" style="display: inline-block; background: linear-gradient(135deg, #6B72FF, #2E37FE); color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-size: 14px; font-weight: 600; letter-spacing: -0.2px;">
                View Full Reply &#8594;
              </a>

              <!-- "or" divider -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 20px auto 0; max-width: 320px;">
                <tr>
                  <td width="130" style="border-bottom: 1px solid #E2E3ED; line-height: 1px; font-size: 1px;">&nbsp;</td>
                  <td style="padding: 0 14px; font-size: 11px; color: #9194AD; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600; white-space: nowrap;">
                    or
                  </td>
                  <td width="130" style="border-bottom: 1px solid #E2E3ED; line-height: 1px; font-size: 1px;">&nbsp;</td>
                </tr>
              </table>

              <a href="${data.portalUrl}" style="display: inline-block; margin-top: 18px; background: #ffffff; color: #2E37FE; text-decoration: none; padding: 12px 32px; border-radius: 10px; font-size: 14px; font-weight: 600; letter-spacing: -0.2px; border: 1.5px solid #D4D7E9;">
                Open in Portal
              </a>
              <p style="margin: 14px 0 0; font-size: 12px; color: #6B6E8A;">
                Fast link expires in 4 hours — portal link never expires
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #ffffff; border-radius: 0 0 16px 16px; padding: 18px 24px; border-top: 1px solid #E2E3ED;">
              <p style="margin: 0; font-size: 12px; color: #6B6E8A;">
                Sent by <strong style="color: #1A1A2E;">LeadStart</strong> · Cold email done right
              </p>
              <p style="margin: 4px 0 0; font-size: 11px; color: #9194AD;">
                You're receiving this because your campaign flagged a hot reply. Manage notification preferences in your admin settings.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}
