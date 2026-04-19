export interface PortalLinkEmailData {
  clientName: string;
  portalUrl: string;
}

export function buildPortalLinkEmail(data: PortalLinkEmailData): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manage your LeadStart billing</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F4F5F9; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F4F5F9;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%;">
          <tr>
            <td style="background: linear-gradient(135deg, #6B72FF 0%, #2E37FE 30%, #1C24B8 65%, #0F1880 100%); border-radius: 16px 16px 0 0; padding: 32px;">
              <p style="margin: 0; color: rgba(255,255,255,0.7); font-size: 13px; text-transform: uppercase; letter-spacing: 1px;">
                LeadStart Billing
              </p>
              <h1 style="margin: 6px 0 0; color: #ffffff; font-size: 22px; font-weight: 700; letter-spacing: -0.4px;">
                Manage your billing
              </h1>
            </td>
          </tr>
          <tr>
            <td style="background: #ffffff; padding: 32px; ">
              <p style="margin: 0 0 16px; font-size: 15px; color: #1A1A2E; line-height: 1.55;">
                Hi ${data.clientName || "there"},
              </p>
              <p style="margin: 0 0 24px; font-size: 14px; color: #3D3D5C; line-height: 1.65;">
                Use the secure link below to update your payment method, review past invoices, and download receipts.
              </p>
              <div style="text-align: center; margin: 0 0 24px;">
                <a href="${data.portalUrl}" style="display: inline-block; background: linear-gradient(135deg, #6B72FF, #2E37FE); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-size: 14px; font-weight: 600; letter-spacing: -0.2px;">
                  Open billing portal &#8594;
                </a>
              </div>
              <p style="margin: 0; font-size: 12px; color: #6B6E8A; text-align: center;">
                The link is unique to your account and expires shortly — do not forward.
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
