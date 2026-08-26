// DNS record-set builders per sending tier (Phase 2). Pure — returns the
// provider-agnostic DnsRecordInput[] the registrar client writes after a domain
// is registered. Actual DKIM keys are added later (Workspace admin console for
// the Gmail tier — no API; Mailcow's API for the SMTP tier).

import type { DnsRecordInput } from "./types";

/**
 * Records a Gmail-tier (Google Workspace) sending domain needs at registration:
 * Google's MX, an SPF authorizing Google, and a monitoring DMARC (p=none) to
 * start. DKIM is generated in the Workspace admin console afterward (Google
 * exposes no API for it) — a poller watches for the google._domainkey TXT and
 * advances the domain to warming.
 */
export function gmailTierRecords(opts?: { dmarcRua?: string }): DnsRecordInput[] {
  const dmarc = opts?.dmarcRua
    ? `v=DMARC1; p=none; rua=mailto:${opts.dmarcRua}`
    : "v=DMARC1; p=none;";
  return [
    // Google's single consolidated MX (current Workspace guidance).
    { type: "MX", name: "", content: "smtp.google.com", ttl: 3600, priority: 1 },
    { type: "TXT", name: "", content: "v=spf1 include:_spf.google.com ~all", ttl: 3600 },
    { type: "TXT", name: "_dmarc", content: dmarc, ttl: 3600 },
  ];
}

/**
 * Records an SMTP-tier (self-hosted) sending domain needs: our mail host as MX,
 * an SPF authorizing the sending IP, a monitoring DMARC, and an A record for the
 * mail host. DKIM (from Mailcow) is appended when its selector + public key are
 * known. `mailHost` is the FQDN of the mail server (e.g. mail.example.com).
 */
export function smtpTierRecords(params: {
  mailHost: string;
  sendingIp: string;
  dmarcRua?: string;
  dkim?: { selector: string; publicKey: string };
}): DnsRecordInput[] {
  const { mailHost, sendingIp } = params;
  const dmarc = params.dmarcRua ? `v=DMARC1; p=none; rua=mailto:${params.dmarcRua}` : "v=DMARC1; p=none;";
  const records: DnsRecordInput[] = [
    { type: "MX", name: "", content: mailHost, ttl: 3600, priority: 10 },
    { type: "TXT", name: "", content: `v=spf1 ip4:${sendingIp} ~all`, ttl: 3600 },
    { type: "TXT", name: "_dmarc", content: dmarc, ttl: 3600 },
  ];
  if (params.dkim) {
    records.push({
      type: "TXT",
      name: `${params.dkim.selector}._domainkey`,
      content: `v=DKIM1; k=rsa; p=${params.dkim.publicKey}`,
      ttl: 3600,
    });
  }
  return records;
}
