// Enterprise License Manager client. Assigns a Workspace license SKU to a user.
// Only used when the org has configured a product/SKU (google_license_*); when
// it hasn't, the tenant auto-licenses new users and the whole step is skipped.

import { GoogleServiceAccount, googleApiFetch, isGoogleStatus } from "./auth";

const BASE = "https://licensing.googleapis.com/apps/licensing/v1";

export const LICENSING_SCOPE =
  "https://www.googleapis.com/auth/apps.licensing";

export class LicensingClient {
  constructor(
    private sa: GoogleServiceAccount,
    private adminSubject: string,
  ) {}

  /**
   * Assign one SKU to one user. 409/412 (already has a license) → treated as
   * done (already: true), so a re-run is a no-op.
   */
  async assignLicense(
    productId: string,
    skuId: string,
    userEmail: string,
  ): Promise<{ assigned: boolean; already: boolean }> {
    try {
      await googleApiFetch({
        sa: this.sa,
        subject: this.adminSubject,
        scopes: LICENSING_SCOPE,
        baseUrl: BASE,
        path: `/product/${encodeURIComponent(productId)}/sku/${encodeURIComponent(skuId)}/user`,
        apiLabel: "Licensing",
        method: "POST",
        body: { userId: userEmail },
      });
      return { assigned: true, already: false };
    } catch (err) {
      if (isGoogleStatus(err, 409) || isGoogleStatus(err, 412)) {
        return { assigned: false, already: true };
      }
      throw err;
    }
  }
}
