// Admin SDK Directory client (domain + user provisioning). Composes the shared
// GoogleServiceAccount (src/lib/google/auth.ts) with the Directory scopes and a
// fixed admin subject (a Workspace super-admin — unlike Gmail sends, the
// Directory API always impersonates the same admin, not a per-mailbox subject).
//
// Resume semantics: insertDomain / insertUser return { created: false } on 409
// (already exists) so a re-run of the provisioning flow is a no-op, not an error.

import { GoogleServiceAccount, googleApiFetch, isGoogleStatus } from "./auth";

const BASE = "https://admin.googleapis.com/admin/directory/v1";

export const DIRECTORY_SCOPES =
  "https://www.googleapis.com/auth/admin.directory.domain " +
  "https://www.googleapis.com/auth/admin.directory.user";

export class DirectoryClient {
  constructor(
    private sa: GoogleServiceAccount,
    private adminSubject: string,
  ) {}

  private call<T>(method: string, path: string, body?: unknown) {
    return googleApiFetch<T>({
      sa: this.sa,
      subject: this.adminSubject,
      scopes: DIRECTORY_SCOPES,
      baseUrl: BASE,
      path,
      apiLabel: "Directory",
      method,
      body,
    });
  }

  /** Add a secondary domain to the existing tenant. 409 → already added (resume). */
  async insertDomain(domain: string): Promise<{ created: boolean; verified: boolean }> {
    try {
      const { json } = await this.call<{ verified?: boolean }>(
        "POST",
        "/customer/my_customer/domains",
        { domainName: domain },
      );
      return { created: true, verified: json.verified === true };
    } catch (err) {
      if (isGoogleStatus(err, 409)) return { created: false, verified: false };
      throw err;
    }
  }

  /** Read a domain's state — the post-verification gate reads `verified`. */
  async getDomain(domain: string): Promise<{ exists: boolean; verified: boolean }> {
    try {
      const { json } = await this.call<{ verified?: boolean }>(
        "GET",
        `/customer/my_customer/domains/${encodeURIComponent(domain)}`,
      );
      return { exists: true, verified: json.verified === true };
    } catch (err) {
      if (isGoogleStatus(err, 404)) return { exists: false, verified: false };
      throw err;
    }
  }

  /** Create a user on a (verified) domain. 409 → already created (resume). */
  async insertUser(spec: {
    primaryEmail: string;
    givenName: string;
    familyName: string;
    password: string;
  }): Promise<{ created: boolean }> {
    try {
      await this.call("POST", "/users", {
        primaryEmail: spec.primaryEmail,
        name: { givenName: spec.givenName, familyName: spec.familyName },
        password: spec.password,
        // These are machine-operated DWD inboxes; nobody performs the interactive
        // first login a forced password change would require.
        changePasswordAtNextLogin: false,
      });
      return { created: true };
    } catch (err) {
      if (isGoogleStatus(err, 409)) return { created: false };
      throw err;
    }
  }

  async getUser(email: string): Promise<{ exists: boolean; suspended: boolean }> {
    try {
      const { json } = await this.call<{ suspended?: boolean }>(
        "GET",
        `/users/${encodeURIComponent(email)}`,
      );
      return { exists: true, suspended: json.suspended === true };
    } catch (err) {
      if (isGoogleStatus(err, 404)) return { exists: false, suspended: false };
      throw err;
    }
  }
}
