// Hot-lead notification email to clients.notification_email.
//
// Shape matches src/lib/email/*: plain HTML string template, inline styles,
// table-based layout for broad mail-client compatibility. Returns both subject
// and html so the orchestrator doesn't have to reconstruct the subject.
//
// Two identities, chosen by whether we know a person:
//  - Known contact (lead_name present): monogram initials + name + title ·
//    company, then Email / Phone / LinkedIn rows.
//  - Generic company inbox (no lead_name, e.g. a Google-Maps info@ lead): a
//    company identity with a "Company email" block, no monogram initials, no
//    LinkedIn.
//
// The reply is shown as a chat bubble. Actions are conditional and equal-width:
//  - Call   (green): only when we have a phone number
//  - Reply  (violet, always): a direct link to the lead's thread in the
//    client's own inbox, where they respond
//  - LinkedIn (blue): only when we have a LinkedIn URL
// No classification label or confidence score is shown to the client.

import type { ReplyClass } from "@/types/app";
import { EMAIL_FONT_STACK, EMAIL_FONT_HEAD } from "@/lib/email/brand";

export interface ClientNotificationEmailData {
  leadName: string | null;
  leadTitle: string | null;
  leadCompany: string | null;
  leadEmail: string;           // always present on a lead_replies row
  leadPhone: string | null;    // displayed as-is; the tel: target is cleaned
  leadLinkedinUrl: string | null;
  replySubject: string | null; // the reply's subject, for the thread byline
  replyBodyPreview: string;    // truncated upstream (~600 chars)
  replyThreadUrl: string;      // absolute URL to this lead's thread in the client inbox
  receivedAt: string;          // ISO
}

export interface BuiltClientNotificationEmail {
  subject: string;
  html: string;
}

// Short, human-readable labels for the reply taxonomy. Kept exported because
// other surfaces (admin badges) reuse it; the client email itself no longer
// renders a class label: the email stays uniform per owner request.
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

// ===== Brand tokens (inline, since email clients don't honor <style> vars) =====
const GRAD = "linear-gradient(135deg, #6B72FF 0%, #2E37FE 30%, #1C24B8 65%, #0F1880 100%)";
const GREEN = "linear-gradient(135deg, #10b981 0%, #059669 100%)";
const BLUE = "linear-gradient(135deg, #2AA4E4 0%, #0A66C2 60%, #044A82 100%)";
const SLATE = "linear-gradient(135deg, #8b93b8 0%, #5b6486 100%)";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Absolute, non-freezing timestamp for the reply byline, e.g. "Sat, 3:26 PM PDT".
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

// Relative "Replied X ago" for the header urgency cue, computed at send time
// (notifications fire within minutes of the reply, so this reads true on open).
function relativeReceived(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "just now";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

// Monogram from a person's name: first + last initial ("Sarah Chen" → "SC").
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "•";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Short LinkedIn label from a URL, e.g. "/in/sarahchen"; falls back gracefully.
function linkedinLabel(url: string): string {
  const m = url.match(/linkedin\.com(\/[^?#]*)/i);
  return m ? m[1].replace(/\/$/, "") : "View profile";
}

// tel: URI, strip everything except + and digits so the phone app gets a clean
// target even if the display format has parens, dashes, spaces.
function telUri(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, "")}`;
}

// One equal-width, filled action button. All three share width + weight so the
// row reads as one control set.
function actionButton(href: string, label: string, background: string): string {
  return (
    `<a href="${href}" style="display:inline-block; width:150px; box-sizing:border-box; ` +
    `text-align:center; background:${background}; color:#ffffff; padding:12px 0; ` +
    `border-radius:10px; font-size:13.5px; font-weight:700; margin:5px 4px; ` +
    `text-decoration:none;">${label}</a>`
  );
}

export function buildClientNotificationEmail(
  data: ClientNotificationEmailData
): BuiltClientNotificationEmail {
  const name = data.leadName?.trim() || "";
  const company = data.leadCompany?.trim() || "";
  const title = data.leadTitle?.trim() || "";
  const email = data.leadEmail?.trim() || "";
  const phone = data.leadPhone?.trim() || "";
  const linkedin = data.leadLinkedinUrl?.trim() || "";
  const isGeneric = !name; // no person identified → company-inbox treatment

  const emailDomain = email.includes("@") ? email.split("@")[1] : "";
  // The company/inbox display name when there's no person.
  const companyLabel = company || emailDomain || "New reply";

  // Subject: person @ company, else company/domain. Stays uniform (no class).
  const subjectWho = name
    ? `${name}${company ? ` @ ${company}` : ""}`
    : companyLabel;
  const subject = `🔔 New hot lead reply: ${subjectWho}`;

  // ---- Identity block (contact card) ----
  let identityCard: string;
  if (isGeneric) {
    identityCard = `
          <tr>
            <td style="background:#ffffff; padding:22px 26px 10px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
                <td width="60" valign="top">
                  <div style="width:52px; height:52px; border-radius:13px; background:${SLATE}; color:#ffffff; font-size:22px; text-align:center; line-height:52px;">🏢</div>
                </td>
                <td valign="top" style="padding-left:14px;">
                  <div style="font-size:19px; font-weight:700; color:#1A1A2E; letter-spacing:-0.3px;">${escapeHtml(companyLabel)}</div>
                  <div style="font-size:11px; color:#1A1A2E; text-transform:uppercase; letter-spacing:0.6px; font-weight:700; margin-top:8px;">Company email</div>
                  <div style="font-size:14px; margin-top:7px;"><a href="mailto:${escapeHtml(email)}" style="color:#2E37FE; font-weight:600; text-decoration:none;">${escapeHtml(email)}</a></div>
                </td>
              </tr></table>
            </td>
          </tr>`;
  } else {
    const subParts = [title, company].filter(Boolean).map(escapeHtml).join(" · ");
    identityCard = `
          <tr>
            <td style="background:#ffffff; padding:22px 26px 10px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
                <td width="60" valign="top">
                  <div style="width:52px; height:52px; border-radius:13px; background:${GRAD}; color:#ffffff; font-size:18px; font-weight:700; text-align:center; line-height:52px;">${escapeHtml(initials(name))}</div>
                </td>
                <td valign="top" style="padding-left:14px;">
                  <div style="font-size:19px; font-weight:700; color:#1A1A2E; letter-spacing:-0.3px;">${escapeHtml(name)}</div>
                  ${subParts ? `<div style="font-size:13.5px; color:#6B6E8A; margin-top:2px;">${subParts}</div>` : ""}
                </td>
              </tr></table>
            </td>
          </tr>`;
  }

  // ---- Detail rows ----
  const detailRow = (label: string, valueHtml: string): string =>
    `<tr><td style="padding:9px 0; border-top:1px solid #EEF0F6; color:#9194AD; width:78px; font-size:13.5px;">${label}</td>` +
    `<td style="padding:9px 0; border-top:1px solid #EEF0F6; font-size:13.5px;">${valueHtml}</td></tr>`;

  const rows: string[] = [];
  if (isGeneric) {
    if (phone) {
      rows.push(
        detailRow(
          "Phone",
          `<a href="${telUri(phone)}" style="color:#1A1A2E; font-weight:600; text-decoration:none;">${escapeHtml(phone)}</a>`
        )
      );
    }
  } else {
    rows.push(
      detailRow(
        "Email",
        `<a href="mailto:${escapeHtml(email)}" style="color:#2E37FE; font-weight:600; text-decoration:none;">${escapeHtml(email)}</a>`
      )
    );
    if (phone) {
      rows.push(
        detailRow(
          "Phone",
          `<a href="${telUri(phone)}" style="color:#1A1A2E; font-weight:600; text-decoration:none;">${escapeHtml(phone)}</a>`
        )
      );
    }
    if (linkedin) {
      rows.push(
        detailRow(
          "LinkedIn",
          `<a href="${escapeHtml(linkedin)}" style="color:#2E37FE; font-weight:600; text-decoration:none;">${escapeHtml(linkedinLabel(linkedin))}</a>`
        )
      );
    }
    if (!phone && !linkedin) {
      rows.push(
        `<tr><td colspan="2" style="padding:9px 0; border-top:1px solid #EEF0F6; color:#B0B3C6; font-size:12px; font-style:italic;">No phone or LinkedIn on file</td></tr>`
      );
    }
  }

  const detailSection = rows.length
    ? `
          <tr>
            <td style="background:#ffffff; padding:8px 26px 4px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows.join("")}</table>
            </td>
          </tr>`
    : "";

  // ---- Reply bubble ----
  const bylineName = isGeneric
    ? `${escapeHtml(companyLabel)} <span style="color:#9194AD; font-weight:500; font-size:12px;">· ${escapeHtml(email)}</span>`
    : `${escapeHtml(name)} <span style="color:#9194AD; font-weight:500; font-size:12px;">replied</span>`;
  const bubbleAvatar = isGeneric
    ? `<div style="width:40px; height:40px; border-radius:50%; background:${SLATE}; color:#ffffff; font-size:17px; text-align:center; line-height:40px;">🏢</div>`
    : `<div style="width:40px; height:40px; border-radius:50%; background:${GRAD}; color:#ffffff; font-size:15px; font-weight:700; text-align:center; line-height:40px;">${escapeHtml(initials(name))}</div>`;
  const receivedText = formatReceivedAt(data.receivedAt);
  const whenLine = [receivedText, data.replySubject?.trim() ? escapeHtml(data.replySubject.trim()) : ""]
    .filter(Boolean)
    .join(" · ");

  const replyBubble = `
          <tr>
            <td style="background:#ffffff; padding:18px 26px 6px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
                <td width="46" valign="top">${bubbleAvatar}</td>
                <td valign="top" style="padding-left:12px;">
                  <div style="font-size:13.5px; font-weight:700; color:#1A1A2E;">${bylineName}</div>
                  ${whenLine ? `<div style="font-size:11.5px; color:#9194AD; margin:1px 0 8px;">${whenLine}</div>` : `<div style="height:8px;"></div>`}
                  <div style="background:#F1F2F9; border-radius:4px 14px 14px 14px; padding:14px 16px; font-size:14px; color:#1A1A2E; line-height:1.58; white-space:pre-wrap;">${escapeHtml(data.replyBodyPreview)}</div>
                </td>
              </tr></table>
            </td>
          </tr>`;

  // ---- Actions (conditional, equal-width) ----
  const buttons: string[] = [];
  if (phone) buttons.push(actionButton(telUri(phone), "📞 Call", GREEN));
  buttons.push(actionButton(data.replyThreadUrl, "Reply &#8594;", GRAD));
  if (linkedin) buttons.push(actionButton(escapeHtml(linkedin), "💼 LinkedIn", BLUE));

  const note = isGeneric
    ? "Reply opens this thread in your inbox: it's the company's general inbox, so whoever monitors it will see it."
    : "Reply opens this lead's thread right in your inbox.";

  const actionsSection = `
          <tr>
            <td style="background:#ffffff; padding:16px 26px 8px; text-align:center;">
              ${buttons.join("\n              ")}
              <p style="margin:12px 0 0; font-size:11.5px; color:#9194AD; line-height:1.5;">${note}</p>
            </td>
          </tr>`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
  ${EMAIL_FONT_HEAD}
</head>
<body style="margin: 0; padding: 0; background-color: #F4F5F9; font-family: ${EMAIL_FONT_STACK}; -webkit-font-smoothing: antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F4F5F9;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%;">

          <!-- Header -->
          <tr>
            <td style="background: ${GRAD}; border-radius: 16px 16px 0 0; padding: 16px 26px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
                <td style="color:#ffffff; font-size:12px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase;">🔔 Hot lead</td>
                <td align="right" style="color:rgba(255,255,255,0.72); font-size:12px;">Replied ${escapeHtml(relativeReceived(data.receivedAt))}</td>
              </tr></table>
            </td>
          </tr>

          <!-- Contact / company card -->
          ${identityCard}

          <!-- Detail rows -->
          ${detailSection}

          <!-- Reply bubble -->
          ${replyBubble}

          <!-- Actions -->
          ${actionsSection}

          <!-- Footer -->
          <tr>
            <td style="background:#ffffff; border-radius:0 0 16px 16px; border-top:1px solid #E2E3ED; padding:16px 24px;">
              <p style="margin:0; font-size:12px; color:#9194AD;">Sent by <strong style="color:#1A1A2E;">LeadStart</strong></p>
              <p style="margin:4px 0 0; font-size:11px; color:#B0B3C6;">You're receiving this because your campaign flagged a hot reply. Manage notification preferences in your admin settings.</p>
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
