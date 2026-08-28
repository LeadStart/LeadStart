// Site Verification client. Mints the DNS TXT token that proves domain
// ownership to Google, then confirms it once the record resolves. Composes the
// shared GoogleServiceAccount with the siteverification scope + the admin
// subject.

import {
  GoogleServiceAccount,
  GoogleTransientError,
  googleApiFetch,
  isGoogleStatus,
} from "./auth";

const BASE = "https://www.googleapis.com/siteVerification/v1";

export const SITE_VERIFICATION_SCOPE =
  "https://www.googleapis.com/auth/siteverification";

export class SiteVerificationClient {
  constructor(
    private sa: GoogleServiceAccount,
    private adminSubject: string,
  ) {}

  private call<T>(method: string, path: string, body?: unknown) {
    return googleApiFetch<T>({
      sa: this.sa,
      subject: this.adminSubject,
      scopes: SITE_VERIFICATION_SCOPE,
      baseUrl: BASE,
      path,
      apiLabel: "Site Verification",
      method,
      body,
    });
  }

  /**
   * Get the DNS TXT token for a domain. The returned string is the full record
   * value ("google-site-verification=…") to write at the apex. Idempotent:
   * re-requesting returns the same token for a given site + method + identity.
   */
  async getDnsToken(domain: string): Promise<string> {
    const { json } = await this.call<{ token?: string }>("POST", "/token", {
      site: { type: "INET_DOMAIN", identifier: domain },
      verificationMethod: "DNS_TXT",
    });
    if (!json.token) {
      throw new GoogleTransientError("Site Verification returned no token.");
    }
    return json.token;
  }

  /**
   * Attempt to verify the domain via its DNS TXT record. Returns
   * { verified: false } (not a throw) when the token hasn't propagated yet
   * (Google answers 400 "token not found"), which is the normal wait state for
   * minutes to hours after the record is written. Any other error re-throws.
   */
  async verifyDomain(domain: string): Promise<{ verified: boolean; detail: string }> {
    try {
      await this.call("POST", "/webResource?verificationMethod=DNS_TXT", {
        site: { type: "INET_DOMAIN", identifier: domain },
      });
      return { verified: true, detail: "Verified." };
    } catch (err) {
      if (isGoogleStatus(err, 400)) {
        return {
          verified: false,
          detail: err instanceof Error ? err.message : "DNS token not found yet.",
        };
      }
      throw err;
    }
  }
}
