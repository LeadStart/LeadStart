// Deliverability pre-flight for the native email channel. Two independent
// checks, both pure-ish (DNS is the only I/O):
//   1. Per-domain authentication — SPF / DKIM / DMARC via live DNS lookups.
//   2. Sequence-copy spam signals — links, trigger phrases, shouting, etc.
//
// This is advisory, not a gate: it surfaces what to fix before a campaign goes
// live so early sends don't land in spam. Sending routes through Google's IPs,
// so authentication + list hygiene + copy are the levers that actually matter.

import { resolveTxt } from "node:dns/promises";

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

export interface CopyIssue {
  severity: "warn" | "info";
  message: string;
}
export interface CopyScore {
  score: number; // 0–100, higher = cleaner
  issues: CopyIssue[];
}

// Classic spam-trigger phrases for cold B2B email. Not exhaustive — the point
// is to catch the obvious offenders, not to be a filter emulator.
const SPAM_PHRASES = [
  "free", "guarantee", "risk-free", "act now", "limited time", "click here",
  "buy now", "order now", "100% free", "no obligation", "winner", "cash bonus",
  "earn money", "make money", "extra income", "$$$", "cheap", "lowest price",
  "credit card", "why pay more", "double your", "this isn't spam",
];

/** Heuristic spam-signal score for the whole sequence's copy. */
export function scoreCopy(steps: { subject: string; body: string }[]): CopyScore {
  const issues: CopyIssue[] = [];
  const joined = steps.map((s) => `${s.subject}\n${s.body}`).join("\n");
  const lower = joined.toLowerCase();

  const linkCount = (joined.match(/https?:\/\//g) || []).length;
  if (linkCount > 2) {
    issues.push({ severity: "warn", message: `${linkCount} links across the sequence — cold email lands best with 0–1.` });
  }

  const foundPhrases = SPAM_PHRASES.filter((p) => lower.includes(p));
  if (foundPhrases.length > 0) {
    issues.push({
      severity: "warn",
      message: `Spam-trigger phrases present: ${foundPhrases.slice(0, 6).join(", ")}${foundPhrases.length > 6 ? "…" : ""}.`,
    });
  }

  steps.forEach((s, i) => {
    const capsWords = s.subject.split(/\s+/).filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w));
    if (capsWords.length >= 2) {
      issues.push({ severity: "warn", message: `Step ${i + 1} subject uses ALL-CAPS words.` });
    }
  });

  if (/[!?]{2,}/.test(joined)) {
    issues.push({ severity: "info", message: "Repeated !!/?? punctuation reads as spammy." });
  }
  steps.forEach((s, i) => {
    if (s.body.trim().length < 40) {
      issues.push({ severity: "info", message: `Step ${i + 1} body is very short.` });
    }
  });

  const warns = issues.filter((x) => x.severity === "warn").length;
  const infos = issues.filter((x) => x.severity === "info").length;
  const score = Math.max(0, 100 - warns * 15 - infos * 5);
  return { score, issues };
}

/** Pull the domain out of an email address (lowercased). */
export function domainOf(email: string): string {
  return email.includes("@") ? email.split("@")[1].trim().toLowerCase() : email.trim().toLowerCase();
}
