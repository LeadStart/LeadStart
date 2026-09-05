// Relative (not "@/") so the standalone tsx test harness can import this
// module without tsconfig path resolution: matches the repo's other pure-lib
// test targets. Webpack resolves this the same in production.
import {
  EMAIL_REGEX,
  isJunkEmail,
  isPersonalEmail,
  emailMatchesName,
} from "../decision-maker/validation";

// Anchored, NON-global copy of the shared email regex. EMAIL_REGEX carries the
// `g` flag, so calling .test() on it directly is stateful (lastIndex) and
// flaky: never do that. Rebuild from its source instead.
export const EMAIL_FULL = new RegExp(`^${EMAIL_REGEX.source}$`);

export interface EmailPerson {
  firstName: string | null;
  lastName: string | null;
  domain: string | null;
}

export interface SanitizeResult {
  email: string | null; // null when rejected
  rejectReason: string | null;
  flags: string[]; // non-fatal notes (kept, never discarded)
}

// Reject provider-returned junk (malformed / tracking-pixel / CDN noise), and
// flag (but keep) emails that look off (name mismatch, generic mailbox, or a
// domain that differs from the company domain). Fatal rejects become
// not_found; flags are appended to the item note.
export function sanitizeFoundEmail(
  email: string | null | undefined,
  person: EmailPerson,
): SanitizeResult {
  const flags: string[] = [];
  if (!email) return { email: null, rejectReason: "no email", flags };
  const e = email.trim().toLowerCase();

  if (!EMAIL_FULL.test(e)) {
    return { email: null, rejectReason: "malformed email", flags };
  }
  if (isJunkEmail(e)) {
    return { email: null, rejectReason: "junk/CDN email", flags };
  }

  const first = person.firstName ?? "";
  const last = person.lastName ?? "";
  if (first && last && !emailMatchesName(e, first, last)) {
    flags.push("email does not match name pattern");
  }
  if (!isPersonalEmail(e)) {
    flags.push("generic mailbox");
  }
  const emailDomain = e.split("@")[1] ?? "";
  if (person.domain && emailDomain && emailDomain !== person.domain.toLowerCase()) {
    flags.push(`email domain (${emailDomain}) differs from company domain (${person.domain})`);
  }

  return { email: e, rejectReason: null, flags };
}
