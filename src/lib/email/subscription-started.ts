export interface SubscriptionStartedEmailData {
  clientName: string;
  planName: string;
  firstChargeDate: string;
  monthlyCents: number;
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

export function buildSubscriptionStartedEmail(
  data: SubscriptionStartedEmailData,
): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're in — LeadStart</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F4F5F9; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F4F5F9;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%;">
          <tr>
            <td style="background: linear-gradient(135deg, #6B72FF 0%, #2E37FE 30%, #1C24B8 65%, #0F1880 100%); border-radius: 16px 16px 0 0; padding: 36px 32px;">
              <p style="margin: 0; color: rgba(255,255,255,0.7); font-size: 13px; text-transform: uppercase; letter-spacing: 1px;">
                Welcome aboard
              </p>
              <h1 style="margin: 6px 0 0; color: #ffffff; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">
                You&rsquo;re in.
              </h1>
            </td>
          </tr>
          <tr>
            <td style="background: #ffffff; padding: 32px;">
              <p style="margin: 0 0 16px; font-size: 16px; color: #1A1A2E; line-height: 1.55;">
                Hi ${data.clientName || "there"},
              </p>
              <p style="margin: 0 0 20px; font-size: 15px; color: #3D3D5C; line-height: 1.65;">
                Thanks for accepting. Your setup fee has been charged and we&rsquo;ve kicked off the 14-day inbox warming process. Your ${data.planName} campaigns will launch right after.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background: #EDEEFF; border: 1px solid #D1D3FF; border-radius: 12px;">
                <tr>
                  <td style="padding: 18px 20px;">
                    <p style="margin: 0; font-size: 11px; color: #2E37FE; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;">
                      First subscription charge
                    </p>
                    <p style="margin: 6px 0 0; font-size: 22px; font-weight: 700; color: #1A1A2E;">
                      ${formatCents(data.monthlyCents)}<span style="color: #6B6E8A; font-size: 14px; font-weight: 500;">/mo</span>
                    </p>
                    <p style="margin: 4px 0 0; font-size: 13px; color: #3D3D5C;">
                      On ${formatDate(data.firstChargeDate)} &mdash; right when your campaigns go live.
                    </p>
                  </td>
                </tr>
              </table>
              <p style="margin: 24px 0 0; font-size: 13px; color: #6B6E8A; line-height: 1.55;">
                Your LeadStart contact will reach out this week with onboarding details. Stripe has sent a receipt for today&rsquo;s charge separately.
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
