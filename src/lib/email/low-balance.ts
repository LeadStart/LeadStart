import { EMAIL_FONT_STACK, EMAIL_FONT_HEAD } from "./brand";
// Buyer low-balance alert email. Sent once when a buyer's available token balance
// crosses below token_pricing_config.low_balance_threshold_tokens (reset on their
// next top-up). Plain, branded, one CTA back to the wallet. Inline-styled tables
// for email-client safety, matching the other src/lib/email templates.

export interface LowBalanceEmailData {
  name: string;
  available: number;
  threshold: number;
  portalUrl: string; // absolute URL to the buyer wallet
}

export const LOW_BALANCE_SUBJECT = "Your LeadStart token balance is running low";

export function buildLowBalanceEmail(data: LowBalanceEmailData): string {
  const available = data.available.toLocaleString();
  const threshold = data.threshold.toLocaleString();
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Low token balance: LeadStart</title>
  ${EMAIL_FONT_HEAD}
</head>
<body style="margin: 0; padding: 0; background-color: #F4F5F9; font-family: ${EMAIL_FONT_STACK}; -webkit-font-smoothing: antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F4F5F9;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%;">
          <tr>
            <td style="background: linear-gradient(135deg, #6B72FF 0%, #2E37FE 30%, #1C24B8 65%, #0F1880 100%); border-radius: 16px 16px 0 0; padding: 36px 32px;">
              <p style="margin: 0; color: rgba(255,255,255,0.7); font-size: 13px; text-transform: uppercase; letter-spacing: 1px;">
                Token balance
              </p>
              <h1 style="margin: 6px 0 0; color: #ffffff; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">
                Your balance is running low.
              </h1>
            </td>
          </tr>
          <tr>
            <td style="background: #ffffff; padding: 32px;">
              <p style="margin: 0 0 16px; font-size: 16px; color: #1A1A2E; line-height: 1.55;">
                Hi ${data.name || "there"},
              </p>
              <p style="margin: 0 0 20px; font-size: 15px; color: #3D3D5C; line-height: 1.65;">
                Your LeadStart token balance has dropped below ${threshold}. Top up so your next searches don&rsquo;t stall for want of tokens.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background: #EDEEFF; border: 1px solid #D1D3FF; border-radius: 12px;">
                <tr>
                  <td style="padding: 18px 20px;">
                    <p style="margin: 0; font-size: 11px; color: #2E37FE; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;">
                      Available balance
                    </p>
                    <p style="margin: 6px 0 0; font-size: 22px; font-weight: 700; color: #1A1A2E;">
                      ${available}<span style="color: #6B6E8A; font-size: 14px; font-weight: 500;"> tokens</span>
                    </p>
                  </td>
                </tr>
              </table>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 24px 0 0;">
                <tr>
                  <td style="border-radius: 10px; background: #2E37FE;">
                    <a href="${data.portalUrl}" style="display: inline-block; padding: 12px 24px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Top up tokens
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin: 24px 0 0; font-size: 13px; color: #6B6E8A; line-height: 1.55;">
                You&rsquo;re only charged for the contacts we actually deliver. Questions? Reach us at <a href="mailto:daniel@leadstart.io" style="color: #2E37FE; font-weight: 600; text-decoration: none;">daniel@leadstart.io</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background: #ffffff; border-radius: 0 0 16px 16px; padding: 20px 24px; border-top: 1px solid #E2E3ED;">
              <p style="margin: 0; font-size: 12px; color: #6B6E8A;">
                Sent by <strong style="color: #1A1A2E;">LeadStart</strong> &middot; Self-serve contact sourcing
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
