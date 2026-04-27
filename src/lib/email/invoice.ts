export interface InvoiceLineItem {
  description: string;
  periodLabel: string | null;
  amountCents: number;
}

export interface InvoiceEmailData {
  clientName: string;
  invoiceNumber: string;
  amountDueCents: number;
  currency: string;
  issuedAt: string;
  dueAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  lineItems: InvoiceLineItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  hostedInvoiceUrl: string;
  invoicePdfUrl: string | null;
}

function formatCents(cents: number, currency: string = "usd"): string {
  const dollars = cents / 100;
  const symbol = currency.toLowerCase() === "usd" ? "$" : "";
  const formatted =
    dollars % 1 === 0
      ? dollars.toLocaleString()
      : dollars.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
  return `${symbol}${formatted}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatPeriodRange(
  startIso: string | null,
  endIso: string | null,
): string {
  if (!startIso || !endIso) return "";
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameYear = start.getFullYear() === end.getFullYear();
  const startStr = formatShortDate(startIso);
  const endStr = sameYear
    ? formatShortDate(endIso)
    : formatDate(endIso);
  return `${startStr} – ${endStr}, ${end.getFullYear()}`;
}

export function buildInvoiceEmail(data: InvoiceEmailData): string {
  const currency = data.currency || "usd";
  const fmt = (cents: number) => formatCents(cents, currency);

  const periodHeading =
    data.periodStart && data.periodEnd
      ? formatPeriodRange(data.periodStart, data.periodEnd)
      : "";

  const dueLabel = data.dueAt
    ? `due ${formatShortDate(data.dueAt)}`
    : "due now";

  const taxRow =
    data.taxCents > 0
      ? `
                  <tr>
                    <td style="padding: 4px 0 10px; font-size: 13px; color: #6B6E8A;">Tax</td>
                    <td align="right" style="padding: 4px 0 10px; font-size: 13px; color: #1A1A2E;">${fmt(data.taxCents)}</td>
                  </tr>`
      : "";

  const lineItemRows = data.lineItems.length
    ? data.lineItems
        .map((item) => {
          const periodSuffix = item.periodLabel
            ? `<div style="font-size: 12px; color: #6B6E8A; margin-top: 2px;">${item.periodLabel}</div>`
            : "";
          return `
                  <tr>
                    <td style="padding: 14px 0; border-bottom: 1px solid #F0F1F6; font-size: 14px; color: #1A1A2E;">
                      ${item.description}
                      ${periodSuffix}
                    </td>
                    <td align="right" style="padding: 14px 0; border-bottom: 1px solid #F0F1F6; font-size: 14px; color: #1A1A2E; vertical-align: top;">${fmt(item.amountCents)}</td>
                  </tr>`;
        })
        .join("")
    : `
                  <tr>
                    <td style="padding: 14px 0; border-bottom: 1px solid #F0F1F6; font-size: 14px; color: #1A1A2E;">
                      LeadStart subscription
                    </td>
                    <td align="right" style="padding: 14px 0; border-bottom: 1px solid #F0F1F6; font-size: 14px; color: #1A1A2E; vertical-align: top;">${fmt(data.totalCents)}</td>
                  </tr>`;

  const periodRow = periodHeading
    ? `
                      <tr>
                        <td style="font-size: 12px; color: #6B6E8A; padding: 4px 0;">Billing period</td>
                        <td align="right" style="font-size: 13px; color: #1A1A2E; padding: 4px 0;">${periodHeading}</td>
                      </tr>`
    : "";

  const dueRow = data.dueAt
    ? `
                      <tr>
                        <td style="font-size: 12px; color: #6B6E8A; padding: 4px 0;">Due</td>
                        <td align="right" style="font-size: 13px; color: #1A1A2E; padding: 4px 0;">${formatDate(data.dueAt)}</td>
                      </tr>`
    : "";

  const pdfFallback = data.invoicePdfUrl
    ? `
              <p style="margin: 0 0 24px; font-size: 13px; color: #6B6E8A; text-align: center;">
                Or <a href="${data.invoicePdfUrl}" style="color: #2E37FE; text-decoration: none; font-weight: 500;">download the PDF</a>
              </p>`
    : `<div style="height: 8px;"></div>`;

  const introPeriod = periodHeading
    ? `for <strong style="color: #1A1A2E;">${periodHeading}</strong> `
    : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${data.invoiceNumber} — LeadStart</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F4F5F9; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F4F5F9;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%;">

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
                  <td style="padding-top: 24px;">
                    <p style="margin: 0; color: rgba(255,255,255,0.7); font-size: 13px; text-transform: uppercase; letter-spacing: 1px;">
                      Invoice ${data.invoiceNumber}
                    </p>
                    <h1 style="margin: 6px 0 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">
                      ${fmt(data.amountDueCents)} <span style="color: rgba(255,255,255,0.7); font-weight: 500; font-size: 16px;">${dueLabel}</span>
                    </h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="background: #ffffff; padding: 32px;">

              <p style="margin: 0 0 16px; font-size: 16px; color: #1A1A2E; line-height: 1.55;">
                Hi ${data.clientName || "there"},
              </p>
              <p style="margin: 0 0 24px; font-size: 14px; color: #3D3D5C; line-height: 1.65;">
                Your LeadStart invoice ${introPeriod}is ready. You can pay it in one click below.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background: #EDEEFF; border: 1px solid #D1D3FF; border-radius: 12px; margin: 0 0 20px;">
                <tr>
                  <td style="padding: 18px 20px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="font-size: 12px; color: #6B6E8A; padding: 4px 0;">Invoice</td>
                        <td align="right" style="font-size: 13px; color: #1A1A2E; font-weight: 600; padding: 4px 0;">${data.invoiceNumber}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 12px; color: #6B6E8A; padding: 4px 0;">Issued</td>
                        <td align="right" style="font-size: 13px; color: #1A1A2E; padding: 4px 0;">${formatDate(data.issuedAt)}</td>
                      </tr>${dueRow}${periodRow}
                    </table>
                  </td>
                </tr>
              </table>

              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin: 0 0 24px; border-collapse: collapse;">
                <thead>
                  <tr>
                    <th align="left" style="font-size: 11px; color: #6B6E8A; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; padding: 10px 0; border-bottom: 1px solid #E2E3ED;">Description</th>
                    <th align="right" style="font-size: 11px; color: #6B6E8A; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; padding: 10px 0; border-bottom: 1px solid #E2E3ED;">Amount</th>
                  </tr>
                </thead>
                <tbody>${lineItemRows}
                </tbody>
                <tfoot>
                  <tr>
                    <td style="padding: 10px 0; font-size: 13px; color: #6B6E8A;">Subtotal</td>
                    <td align="right" style="padding: 10px 0; font-size: 13px; color: #1A1A2E;">${fmt(data.subtotalCents)}</td>
                  </tr>${taxRow}
                  <tr>
                    <td style="padding: 12px 0 4px; font-size: 14px; color: #1A1A2E; font-weight: 700; border-top: 2px solid #1A1A2E;">Amount due</td>
                    <td align="right" style="padding: 12px 0 4px; font-size: 18px; color: #1A1A2E; font-weight: 700; border-top: 2px solid #1A1A2E;">${fmt(data.amountDueCents)}</td>
                  </tr>
                </tfoot>
              </table>

              <div style="text-align: center; margin: 0 0 16px;">
                <a href="${data.hostedInvoiceUrl}" style="display: inline-block; background: linear-gradient(135deg, #6B72FF, #2E37FE); color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-size: 14px; font-weight: 600; letter-spacing: -0.2px;">
                  Pay invoice &#8594;
                </a>
              </div>
${pdfFallback}
              <p style="margin: 0; padding-top: 20px; border-top: 1px solid #F0F1F6; font-size: 12px; color: #9194AD; line-height: 1.55; text-align: center;">
                Payments are processed securely by Stripe. Save the PDF for your records.
              </p>

            </td>
          </tr>

          <tr>
            <td style="background: #ffffff; border-radius: 0 0 16px 16px; padding: 20px 24px; border-top: 1px solid #E2E3ED;">
              <p style="margin: 0; font-size: 12px; color: #6B6E8A;">
                Sent by <strong style="color: #1A1A2E;">LeadStart</strong> &middot; Cold email done right
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
