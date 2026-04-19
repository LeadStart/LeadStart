export interface QuoteEmailData {
  contactName: string;
  quoteNumber: string;
  planName: string;
  monthlyCents: number;
  setupCents: number;
  quoteUrl: string;
  expiresAt: string | null;
}

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString()}`
    : `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function buildQuoteProposalEmail(data: QuoteEmailData): string {
  const expiryLine = data.expiresAt
    ? `This proposal is valid through <strong style="color: #1A1A2E;">${formatDate(data.expiresAt)}</strong>.`
    : "This proposal remains valid until withdrawn.";

  const setupRow =
    data.setupCents > 0
      ? `
        <tr>
          <td style="padding: 12px 0; color: #3D3D5C; font-size: 14px;">One-time setup fee</td>
          <td style="padding: 12px 0; text-align: right; color: #1A1A2E; font-weight: 600;">${formatCents(data.setupCents)}</td>
        </tr>`
      : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your LeadStart proposal — ${data.quoteNumber}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F4F5F9; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased;">

  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F4F5F9;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%;">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #6B72FF 0%, #2E37FE 30%, #1C24B8 65%, #0F1880 100%); border-radius: 16px 16px 0 0; padding: 36px 32px;">
              <p style="margin: 0; color: rgba(255,255,255,0.7); font-size: 13px; text-transform: uppercase; letter-spacing: 1px;">
                LeadStart Proposal
              </p>
              <h1 style="margin: 6px 0 0; color: #ffffff; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">
                Your ${data.planName} proposal is ready
              </h1>
              <p style="margin: 8px 0 0; color: rgba(255,255,255,0.7); font-size: 14px;">
                ${data.quoteNumber}
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background: #ffffff; padding: 32px 32px 24px;">
              <p style="margin: 0 0 16px; font-size: 16px; color: #1A1A2E; line-height: 1.55;">
                Hi ${data.contactName || "there"},
              </p>
              <p style="margin: 0 0 24px; font-size: 15px; color: #3D3D5C; line-height: 1.6;">
                Here's the proposal we prepared for you. Review the scope and
                pricing, then click <strong style="color: #1A1A2E;">Review proposal</strong>
                below to accept and get your inboxes warming.
              </p>

              <!-- Pricing card -->
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background: #EDEEFF; border: 1px solid #D1D3FF; border-radius: 12px; padding: 0; margin: 0 0 24px;">
                <tr>
                  <td style="padding: 18px 20px;">
                    <p style="margin: 0 0 10px; font-size: 11px; color: #2E37FE; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;">
                      At a glance
                    </p>
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                      ${setupRow}
                      <tr>
                        <td style="padding: 12px 0; border-top: 1px solid rgba(46,55,254,0.15); color: #3D3D5C; font-size: 14px;">
                          ${data.planName} — monthly
                        </td>
                        <td style="padding: 12px 0; border-top: 1px solid rgba(46,55,254,0.15); text-align: right; color: #1A1A2E; font-weight: 600;">
                          ${formatCents(data.monthlyCents)}<span style="color: #6B6E8A; font-weight: 500; font-size: 13px;">/mo</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <div style="text-align: center; margin: 0 0 20px;">
                <a href="${data.quoteUrl}" style="display: inline-block; background: linear-gradient(135deg, #6B72FF, #2E37FE); color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-size: 15px; font-weight: 600; letter-spacing: -0.2px;">
                  Review proposal &#8594;
                </a>
              </div>

              <p style="margin: 0 0 8px; font-size: 13px; color: #6B6E8A; text-align: center;">
                ${expiryLine}
              </p>
              <p style="margin: 0; font-size: 12px; color: #9194AD; text-align: center;">
                Secure link — do not forward.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #ffffff; border-radius: 0 0 16px 16px; padding: 20px 24px; border-top: 1px solid #E2E3ED;">
              <p style="margin: 0; font-size: 12px; color: #6B6E8A;">
                Sent by <strong style="color: #1A1A2E;">LeadStart</strong> &middot; Cold email done right
              </p>
              <p style="margin: 4px 0 0; font-size: 11px; color: #9194AD;">
                Questions? Reply to this email and we'll get back to you the same day.
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
