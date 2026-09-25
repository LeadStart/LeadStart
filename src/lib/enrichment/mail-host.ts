// Prospect mail host: who runs a firm's email, read from its domain's MX
// records (a free DNS lookup). It predicts how well our email finding will do,
// because it decides whether Million Verifier can confirm a guessed address:
//
//   microsoft365  rejects unknown addresses → guesses get a clear ok/invalid
//   google        mostly the same (some small domains route everything)
//   gateway       Proofpoint/Mimecast/Barracuda… accept everything → catch-all
//   godaddy       usually catch-all
//   other         small/self-hosted mail, often catch-all
//   none          no mail server at all (no MX, or the domain doesn't exist)
//
// Measured on 873 enriched WA law firms (2026-09-25): 44% of Microsoft 365 firms
// became TuBe-ready vs 29% Google, 22% gateways, 18% other hosts, 9% no MX,
// 0% GoDaddy. Maps firms on a WEAK host are set aside in the pool (lib/enrichment/
// pool.ts) instead of being enriched, and address guessing is skipped for
// domains with no mail server (pattern_mv).
//
// Server-only (node:dns). The stamp lives on contacts.enrichment_data.mail_host.

import { Resolver } from "node:dns/promises";

export type MailHost = "microsoft365" | "google" | "gateway" | "godaddy" | "other" | "none";

export interface MailHostStamp {
  host: MailHost;
  /** Lowest-priority MX exchange (null when there is none). */
  mx: string | null;
  checked_at: string;
}

export const MAIL_HOST_LABEL: Record<MailHost, string> = {
  microsoft365: "Microsoft 365",
  google: "Google Workspace",
  gateway: "Security gateway",
  godaddy: "GoDaddy mail",
  other: "Other host",
  none: "No mail server",
};

/** Pure: classify an MX exchange hostname. */
export function classifyMxExchange(exchange: string): MailHost {
  const h = exchange.toLowerCase().replace(/\.$/, "");
  if (/(^|\.)(google\.com|googlemail\.com)$/.test(h)) return "google"; // aspmx.l.google.com, smtp.google.com…
  if (/(^|\.)(outlook\.com|outlook\.de|office365\.us)$/.test(h)) return "microsoft365"; // <tenant>.mail.protection.outlook.com
  if (/(^|\.)secureserver\.net$/.test(h)) return "godaddy";
  if (/pphosted\.com$|ppe-hosted\.com$|proofpoint|mimecast|barracudanetworks\.com$|messagelabs\.com$|iphmx\.com$|trendmicro|mailcontrol\.com$|sophos/.test(h)) return "gateway";
  return "other";
}

/** Hosts where guessed addresses rarely verify. Maps firms on these are pooled
 *  (set aside, not enriched); Microsoft 365, Google and anything we couldn't
 *  classify are enriched as normal. */
export const WEAK_MAIL_HOSTS: ReadonlySet<MailHost> = new Set<MailHost>(["gateway", "godaddy", "other", "none"]);

export function isWeakMailHost(host: MailHost | null | undefined): boolean {
  return host != null && WEAK_MAIL_HOSTS.has(host);
}

/** Pure: read the stamp off contacts.enrichment_data (null when never checked). */
export function readMailHost(enrichmentData: unknown): MailHost | null {
  const ed = enrichmentData && typeof enrichmentData === "object" ? (enrichmentData as Record<string, unknown>) : null;
  const stamp = ed?.mail_host && typeof ed.mail_host === "object" ? (ed.mail_host as Record<string, unknown>) : null;
  const host = stamp?.host;
  return typeof host === "string" && host in MAIL_HOST_LABEL ? (host as MailHost) : null;
}

type Lookup = { host: MailHost; mx: string | null };

function fromRecords(records: { priority: number; exchange: string }[]): Lookup {
  // A "null MX" (RFC 7505: exchange ".") means the domain accepts no mail at all.
  const sorted = records
    .map((r) => ({ priority: r.priority, exchange: (r.exchange ?? "").trim().toLowerCase().replace(/\.$/, "") }))
    .filter((r) => r.exchange)
    .sort((a, b) => a.priority - b.priority);
  if (sorted.length === 0) return { host: "none", mx: null };
  return { host: classifyMxExchange(sorted[0].exchange), mx: sorted[0].exchange };
}

// DNS-over-HTTPS fallback for environments whose resolver refuses port 53.
async function lookupViaDoh(domain: string, timeoutMs: number): Promise<Lookup | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, {
      signal: controller.signal,
      headers: { Accept: "application/dns-json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] };
    if (j.Status === 3) return { host: "none", mx: null }; // NXDOMAIN
    if (j.Status !== 0) return null; // SERVFAIL etc.: unknown, never "none"
    const records = (j.Answer ?? [])
      .filter((a) => a.type === 15 && typeof a.data === "string")
      .map((a) => {
        const [pri, ex] = (a.data as string).split(/\s+/);
        return { priority: Number(pri) || 0, exchange: ex ?? "" };
      });
    return fromRecords(records);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One domain's mail host, or null when the lookup failed (never guessed). */
export async function lookupMailHost(domain: string, timeoutMs = 3000): Promise<Lookup | null> {
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  if (!d || !d.includes(".")) return null;
  try {
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    return fromRecords(await resolver.resolveMx(d));
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Definitive answers from the resolver: the domain has no mail server.
    if (code === "ENODATA" || code === "ENOTFOUND") return { host: "none", mx: null };
    // Resolver unreachable / timed out / refused → ask DNS-over-HTTPS instead.
    return lookupViaDoh(d, timeoutMs);
  }
}

/** Many domains, bounded by concurrency and an overall time budget. Domains not
 *  answered inside the budget are simply absent from the map (checked later). */
export async function lookupMailHosts(
  domains: string[],
  opts: { concurrency?: number; budgetMs?: number; timeoutMs?: number } = {},
): Promise<Map<string, MailHostStamp>> {
  const unique = Array.from(new Set(domains.map((d) => d.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean)));
  const out = new Map<string, MailHostStamp>();
  const deadline = Date.now() + (opts.budgetMs ?? 8000);
  const conc = Math.max(1, Math.min(opts.concurrency ?? 16, unique.length || 1));
  let idx = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() > deadline) return;
      const i = idx++;
      if (i >= unique.length) return;
      const r = await lookupMailHost(unique[i], opts.timeoutMs ?? 3000);
      if (r) out.set(unique[i], { host: r.host, mx: r.mx, checked_at: new Date().toISOString() });
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  return out;
}
