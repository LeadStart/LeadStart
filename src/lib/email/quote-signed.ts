export interface QuoteSignedEmailData {
  clientName: string;
  monthlyCents: number;
  /** One-time total collected at acceptance (setup + contact sourcing). */
  dueTodayCents: number;
  warmingDays: number;
  /** Launch day = first monthly charge (business-day adjusted). */
  launchDate: string;
  contactsCount: number | null;
  adminUrl: string;
}

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString()}`
    : `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Internal admin alert — fires to the owner when a client signs and pays a
 * quote. Plain, dense, scannable; not client-facing.
 */
export function buildQuoteSignedEmail(data: QuoteSignedEmailData): string {
  const cell = (label: string, value: string) => `
    <td style="width: 50%; padding: 6px;">
      <div style="background: #F8FAFC; border: 1px solid #EEF1F6; border-radius: 9px; padding: 10px 12px;">
        <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: #94A3B8; font-weight: 700;">${label}</div>
        <div style="font-size: 15px; font-weight: 700; color: #0F172A; margin-top: 2px;">${value}</div>
      </div>
    </td>`;

  const contactsLine = data.contactsCount
    ? `<p style="margin: 0 0 16px; font-size: 13px; color: #64748B;">Contacts sold: <strong style="color:#0F172A;">${data.contactsCount.toLocaleString()}</strong>. Sourcing kicks off now.</p>`
    : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quote signed — ${data.clientName}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #EEF1F6; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #EEF1F6;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width: 560px; width: 100%; background: #ffffff; border: 1px solid #E2E8F0; border-radius: 14px; overflow: hidden;">
          <tr>
            <td style="background: #0F172A; padding: 16px 20px;">
              <span style="font-size: 16px; font-weight: 700; color: #ffffff;">Quote signed</span>
              <span style="float: right; font-size: 10.5px; font-weight: 700; color: #6EE7B7; border: 1px solid rgba(16,185,129,0.4); background: rgba(16,185,129,0.16); padding: 3px 9px; border-radius: 999px;">NEW CLIENT</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 18px 20px 20px;">
              <p style="margin: 0 0 14px; font-size: 15px; color: #3D3D5C; line-height: 1.55;">
                <strong style="color:#0F172A;">${data.clientName}</strong> just accepted and paid their proposal.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin: 0 0 8px;">
                <tr>${cell("Lead management", `${formatCents(data.monthlyCents)}/mo`)}${cell("Collected today", formatCents(data.dueTodayCents))}</tr>
                <tr>${cell("Warm-up", `${data.warmingDays} cal. days`)}${cell("Launch &amp; first charge", formatDate(data.launchDate))}</tr>
              </table>
              <div style="height: 8px;"></div>
              ${contactsLine}
              <a href="${data.adminUrl}" style="display: inline-block; background: #2E37FE; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 13.5px; font-weight: 700;">
                Open in admin &#8594;
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
