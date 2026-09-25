// Deliverability pre-flight for the native email channel. Two independent
// checks, both pure-ish (DNS is the only I/O):
//   1. Per-domain authentication: SPF / DKIM / DMARC via live DNS lookups.
//   2. Sequence-copy spam signals: links, trigger phrases, shouting, etc.
//
// This is advisory, not a gate: it surfaces what to fix before a campaign goes
// live so early sends don't land in spam. Sending routes through Google's IPs,
// so authentication + list hygiene + copy are the levers that actually matter.

import { resolveTxt, resolveMx, Resolver } from "node:dns/promises";

// The copy scorer lives in a client-safe sibling (no node: imports) so the
// builder UI can import it without pulling node:dns into the client bundle.
// Re-exported here so existing consumers of "@/lib/deliverability/check" keep
// resolving unchanged.
export { scoreCopy, findSpamMatches } from "./copy";
export type { CopyIssue, CopyScore, StepCopyResult, SpamMatch } from "./copy";

// "unknown" = the lookup itself failed (timeout / SERVFAIL / refused), so we
// don't know whether the record exists. Never graded as missing: see lookup().
export type AuthStatus = "pass" | "warn" | "fail" | "unknown";
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

// ── Lookups: an answer vs. a failure to get one ─────────────────────────────
// NXDOMAIN / NODATA is the DNS saying "no such record": a real answer, graded
// as missing. A timeout, SERVFAIL or refusal is NOT an answer. This used to be
// swallowed as "no record", so one resolver hiccup read as "no SPF, no DMARC,
// no MX" and knocked 50 points off every inbox on the domain in one hourly
// check: with any other deduction, a false "critical" (owner alert; auto-pause
// if it lasted two checks). Now a failed lookup is retried once through public
// resolvers and, if that fails too, reported "unknown" (scored as unchecked).
// Same stance as the Spamhaus check in ./dnsbl.ts.
const ABSENT_CODES = new Set(["ENOTFOUND", "ENODATA"]);

export class DnsLookupError extends Error {
  constructor(public readonly code: string) {
    super(`DNS lookup failed (${code})`);
    this.name = "DnsLookupError";
  }
}

/** One resolver's TXT + MX lookups (injectable so tests can simulate failures). */
export interface DnsLookups {
  txt: (name: string) => Promise<string[][]>;
  mx: (name: string) => Promise<{ exchange: string; priority: number }[]>;
}

let publicResolver: Resolver | null = null;
function fallbackResolver(): Resolver {
  if (!publicResolver) {
    publicResolver = new Resolver({ timeout: 2500, tries: 2 });
    publicResolver.setServers(["1.1.1.1", "8.8.8.8"]);
  }
  return publicResolver;
}

/** The runtime's resolver first, then public resolvers as a second opinion. */
export const DEFAULT_DNS: DnsLookups[] = [
  { txt: (n) => resolveTxt(n), mx: (n) => resolveMx(n) },
  { txt: (n) => fallbackResolver().resolveTxt(n), mx: (n) => fallbackResolver().resolveMx(n) },
];

/**
 * Records, [] for an authoritative "no such record", or DnsLookupError when no
 * resolver could answer at all.
 */
async function lookup<T>(run: (d: DnsLookups) => Promise<T[]>, resolvers: DnsLookups[]): Promise<T[]> {
  let lastCode = "EUNKNOWN";
  for (const r of resolvers) {
    try {
      return await run(r);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "EUNKNOWN";
      if (ABSENT_CODES.has(code)) return [];
      lastCode = code;
    }
  }
  throw new DnsLookupError(lastCode);
}

function unknownCheck(label: string, err: unknown): AuthCheck {
  const code = err instanceof DnsLookupError ? err.code : "error";
  return {
    status: "unknown",
    detail: `Couldn't check ${label} right now (DNS lookup failed: ${code}); not scored, retried next run.`,
  };
}

/**
 * Live SPF / DKIM / DMARC check for one sending domain. Google Workspace uses
 * the `google` DKIM selector by default, so we probe that. A record whose
 * lookup failed reads "unknown", never "fail".
 */
export async function checkDomainAuth(
  domain: string,
  resolvers: DnsLookups[] = DEFAULT_DNS,
): Promise<DomainAuth> {
  // Each TXT record can be split into chunks; join them back.
  const txt = (name: string) =>
    lookup((r) => r.txt(name), resolvers).then(
      (rows) => ({ ok: true as const, records: rows.map((chunks) => chunks.join("")) }),
      (err: unknown) => ({ ok: false as const, err }),
    );
  const [rootRes, dkimRes, dmarcRes] = await Promise.all([
    txt(domain),
    txt(`google._domainkey.${domain}`),
    txt(`_dmarc.${domain}`),
  ]);

  let spf: AuthCheck;
  if (!rootRes.ok) {
    spf = unknownCheck("SPF", rootRes.err);
  } else {
    const spfRec = rootRes.records.find((r) => /^v=spf1/i.test(r.trim()));
    if (!spfRec) {
      spf = { status: "fail", detail: "No SPF record found." };
    } else if (/include:_spf\.google\.com/i.test(spfRec)) {
      spf = { status: "pass", detail: "SPF present and authorizes Google." };
    } else {
      spf = { status: "warn", detail: "SPF present but missing include:_spf.google.com (required for Gmail sending)." };
    }
  }

  const dkimRec = dkimRes.ok ? dkimRes.records.find((r) => /v=DKIM1/i.test(r)) : undefined;
  const dkim: AuthCheck = !dkimRes.ok
    ? unknownCheck("DKIM", dkimRes.err)
    : dkimRec
      ? { status: "pass", detail: "DKIM published on the google selector." }
      : { status: "warn", detail: "No DKIM on the 'google' selector, enable it in Google Admin → Gmail → Authenticate email (or a custom selector is in use)." };

  if (!dmarcRes.ok) return { domain, spf, dkim, dmarc: unknownCheck("DMARC", dmarcRes.err) };
  const dmarcRec = dmarcRes.records.find((r) => /^v=DMARC1/i.test(r.trim()));
  let dmarcCheck: AuthCheck;
  if (!dmarcRec) {
    dmarcCheck = { status: "fail", detail: "No DMARC record found." };
  } else {
    const policy = dmarcRec.match(/\bp=(\w+)/i)?.[1]?.toLowerCase() ?? "none";
    if (policy === "none") {
      // A published DMARC record with p=none is monitoring-only: it reports but
      // enforces nothing, so it gives no spoofing protection and the weakest
      // deliverability signal of the three policies. Passing SPF+DKIM already
      // cover authentication; this is a soft nudge to strengthen the policy
      // once alignment is confirmed, not a hard failure.
      dmarcCheck = {
        status: "warn",
        detail:
          "DMARC present but p=none (monitoring only, set p=quarantine or p=reject once SPF/DKIM alignment is confirmed to enforce it).",
      };
    } else {
      dmarcCheck = { status: "pass", detail: `DMARC present and enforcing (p=${policy}).` };
    }
  }

  return { domain, spf, dkim, dmarc: dmarcCheck };
}

/**
 * Live MX check for a sending domain. A domain with no MX records can't
 * receive the bounce reports and replies our poller depends on, and is a
 * strong signal something is misconfigured. Kept separate from DomainAuth
 * (not folded into checkDomainAuth) so the campaign deliverability card, which
 * consumes DomainAuth, is unaffected: only the inbox-health cron calls this.
 */
export async function checkMx(
  domain: string,
  resolvers: DnsLookups[] = DEFAULT_DNS,
): Promise<AuthCheck> {
  let rows: { exchange: string; priority: number }[];
  try {
    rows = await lookup((r) => r.mx(domain), resolvers);
  } catch (err) {
    // The lookup failed; that says nothing about whether MX exists.
    return unknownCheck("MX", err);
  }
  if (rows.length > 0) {
    return {
      status: "pass",
      detail: `MX present (${rows.length} record${rows.length === 1 ? "" : "s"}).`,
    };
  }
  return {
    status: "fail",
    detail: "No MX records, replies and bounce reports can't reach this domain.",
  };
}

/** Pull the domain out of an email address (lowercased). */
export function domainOf(email: string): string {
  return email.includes("@") ? email.split("@")[1].trim().toLowerCase() : email.trim().toLowerCase();
}
