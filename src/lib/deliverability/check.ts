// Deliverability pre-flight for the native email channel. Two independent
// checks, both pure-ish (DNS is the only I/O):
//   1. Per-domain authentication — SPF / DKIM / DMARC via live DNS lookups.
//   2. Sequence-copy spam signals — links, trigger phrases, shouting, etc.
//
// This is advisory, not a gate: it surfaces what to fix before a campaign goes
// live so early sends don't land in spam. Sending routes through Google's IPs,
// so authentication + list hygiene + copy are the levers that actually matter.

import { resolveTxt } from "node:dns/promises";

// The copy scorer lives in a client-safe sibling (no node: imports) so the
// builder UI can import it without pulling node:dns into the client bundle.
// Re-exported here so existing consumers of "@/lib/deliverability/check" keep
// resolving unchanged.
export { scoreCopy, findSpamMatches } from "./copy";
export type { CopyIssue, CopyScore, StepCopyResult, SpamMatch } from "./copy";

export type AuthStatus = "pass" | "warn" | "fail";
export interface AuthCheck {
  status: AuthStatus;
  detail: string;
}
export interface DomainAuth {
  domain: string;
  spf: AuthCheck;
  dkim: AuthCheck;
  dmarc: AuthCheck;
}

async function txt(name: string): Promise<string[]> {
  try {
    // Each TXT record can be split into chunks; join them back.
    return (await resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch {
    return []; // NXDOMAIN / ENODATA / timeout → treated as "not found"
  }
}

/**
 * Live SPF / DKIM / DMARC check for one sending domain. Google Workspace uses
 * the `google` DKIM selector by default, so we probe that.
 */
export async function checkDomainAuth(domain: string): Promise<DomainAuth> {
  const [root, dkimSel, dmarc] = await Promise.all([
    txt(domain),
    txt(`google._domainkey.${domain}`),
    txt(`_dmarc.${domain}`),
  ]);

  const spfRec = root.find((r) => /^v=spf1/i.test(r.trim()));
  let spf: AuthCheck;
  if (!spfRec) {
    spf = { status: "fail", detail: "No SPF record found." };
  } else if (/include:_spf\.google\.com/i.test(spfRec)) {
    spf = { status: "pass", detail: "SPF present and authorizes Google." };
  } else {
    spf = { status: "warn", detail: "SPF present but missing include:_spf.google.com (required for Gmail sending)." };
  }

  const dkimRec = dkimSel.find((r) => /v=DKIM1/i.test(r));
  const dkim: AuthCheck = dkimRec
    ? { status: "pass", detail: "DKIM published on the google selector." }
    : { status: "warn", detail: "No DKIM on the 'google' selector — enable it in Google Admin → Gmail → Authenticate email (or a custom selector is in use)." };

  const dmarcRec = dmarc.find((r) => /^v=DMARC1/i.test(r.trim()));
  let dmarcCheck: AuthCheck;
  if (!dmarcRec) {
    dmarcCheck = { status: "fail", detail: "No DMARC record found." };
  } else {
    const policy = dmarcRec.match(/\bp=(\w+)/i)?.[1]?.toLowerCase() ?? "none";
    dmarcCheck = { status: "pass", detail: `DMARC present (p=${policy}).` };
  }

  return { domain, spf, dkim, dmarc: dmarcCheck };
}

/** Pull the domain out of an email address (lowercased). */
export function domainOf(email: string): string {
  return email.includes("@") ? email.split("@")[1].trim().toLowerCase() : email.trim().toLowerCase();
}
