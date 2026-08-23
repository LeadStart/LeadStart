// Shared presentation for an email-verification status: a badge label + one of
// the repo's badge utility classes (globals.css). No React so both the admin
// contacts list and the campaign detail page can import it.

import type { EmailVerificationStatus } from "@/types/app";

export interface VerificationBadge {
  label: string;
  className: "badge-green" | "badge-amber" | "badge-red" | "badge-slate";
}

// Returns null when there is nothing to show (status not yet verified) so the
// caller can render no badge at all.
export function verificationBadge(
  status: EmailVerificationStatus | null | undefined,
): VerificationBadge | null {
  switch (status) {
    case "ok":
      return { label: "Verified", className: "badge-green" };
    case "catch_all":
      return { label: "Catch-all", className: "badge-amber" };
    case "unknown":
      return { label: "Unverified", className: "badge-amber" };
    case "invalid":
      return { label: "Invalid", className: "badge-red" };
    case "disposable":
      return { label: "Disposable", className: "badge-red" };
    case "error":
      return { label: "Check failed", className: "badge-slate" };
    default:
      return null;
  }
}
