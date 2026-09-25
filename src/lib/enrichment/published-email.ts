// Published owner addresses: an email the firm itself publishes on its own
// website (found by the naming phase's site read, our site scrape, or Scrap.io's
// crawl of the site), as opposed to one we GUESSED (pattern_mv).
//
// Why it matters: on a catch-all domain the mail server accepts every address,
// so Million Verifier can only answer "catch_all" for anything there. A guessed
// first.last@ may not exist (the mail is accepted and goes nowhere), but an
// address the firm publishes is a real mailbox. So a published address that
// belongs to the named owner is trusted even when the verifier can't confirm it
// (TuBe upload rule), and replaces a catch-all guess when we have one (pattern_mv
// catch-all pass in run-apify-enrichment).
//
// Pure: no I/O, safe on the client. Relative import so the standalone tsx test
// harness resolves it without tsconfig paths.

import { isPersonalEmail, emailMatchesName } from "../decision-maker/validation";

/** Email providers whose address was READ off the firm's site, never guessed. */
export const PUBLISHED_EMAIL_PROVIDERS: ReadonlySet<string> = new Set(["site_scrape", "decision_maker", "site_published"]);

export function isPublishedEmailProvider(provider: string | null | undefined): boolean {
  return Boolean(provider) && PUBLISHED_EMAIL_PROVIDERS.has(provider as string);
}

const letters = (s: string | null | undefined) =>
  (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

function hostOf(domainOrUrl: string | null | undefined): string {
  return (domainOrUrl ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
}

/** True when the address is on the firm's own website domain (or a subdomain). */
export function emailOnFirmDomain(email: string, firmDomain: string | null | undefined): boolean {
  const d = hostOf(firmDomain);
  const at = email.toLowerCase().split("@")[1] ?? "";
  return Boolean(d) && (at === d || at.endsWith(`.${d}`));
}

/** True when the local part identifies the named owner: the usual conventions
 *  (john, smith, jsmith, john.smith…), or the owner's first or last name
 *  (3+ letters) inside it (joseph@, jsmith.law@). Generic inboxes never match. */
export function emailMatchesOwner(email: string, first: string | null | undefined, last: string | null | undefined): boolean {
  if (!email.includes("@") || !isPersonalEmail(email)) return false;
  const f = letters(first);
  const l = letters(last);
  if (f && l && emailMatchesName(email, f, l)) return true;
  const local = letters(email.split("@")[0]);
  if (!local) return false;
  return (l.length >= 3 && local.includes(l)) || (f.length >= 3 && local.includes(f));
}

/** The owner's own published address among the emails seen on the firm's site,
 *  or null. Only addresses on the firm's domain that identify the owner count. */
export function pickPublishedOwnerEmail(
  emails: unknown,
  owner: { first: string | null | undefined; last: string | null | undefined; domain: string | null | undefined },
): string | null {
  if (!Array.isArray(emails)) return null;
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const raw of emails) {
    const e = (typeof raw === "string" ? raw : (raw as { email?: unknown } | null)?.email);
    if (typeof e !== "string") continue;
    const email = e.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (emailOnFirmDomain(email, owner.domain) && emailMatchesOwner(email, owner.first, owner.last)) matches.push(email);
  }
  if (matches.length === 0) return null;
  // Prefer the strongest identifier: the conventional name patterns first.
  const f = letters(owner.first), l = letters(owner.last);
  return matches.find((m) => f && l && emailMatchesName(m, f, l)) ?? matches[0];
}

/** Every address the firm publishes that we hold for a contact: the site
 *  scrape's list (enrichment_data.enrichment.company_emails) plus Scrap.io's
 *  crawl of the site (enrichment_data.source_row.scrapio_emails). */
export function publishedEmailsOf(enrichmentData: unknown): string[] {
  const ed = enrichmentData && typeof enrichmentData === "object" ? (enrichmentData as Record<string, unknown>) : {};
  const enr = ed.enrichment && typeof ed.enrichment === "object" ? (ed.enrichment as Record<string, unknown>) : {};
  const row = ed.source_row && typeof ed.source_row === "object" ? (ed.source_row as Record<string, unknown>) : {};
  const out: string[] = [];
  for (const list of [enr.company_emails, row.scrapio_emails]) {
    if (!Array.isArray(list)) continue;
    for (const e of list) if (typeof e === "string" && e.includes("@")) out.push(e.trim().toLowerCase());
  }
  return Array.from(new Set(out));
}
