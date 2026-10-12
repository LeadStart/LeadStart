// A LinkedIn profile email on a business domain other than the contact's own
// company is, in practice, the person's address at ANOTHER employer: the profile
// scraper's email search looks at the company LinkedIn lists first, often a side
// job. Measured on run ac01fd98 (65 cleaning-firm owners, 2026-10-11): 6 of the 33
// profile emails were at a side job (a realty brokerage, a coffee franchise twice,
// an inspection-report firm…), every one Million Verifier "ok" or catch-all, so
// the send gate would have mailed them. Judged once the domains phase has resolved
// each company's domain (run-apify-enrichment, demoteOtherEmployerEmails): such an
// address is set aside in enrichment_data and the waterfall looks for one at the
// company's own domain. A free mailbox is the person's own and stays; a contact
// with no company domain can't be judged and keeps its email.
//
// Checked against the same run, the simpler rule "the first listed role must be
// the contact's company" also rejected 2 correct emails (the actor does not always
// search the first role); comparing domains rejected only the 6.

// Personal mailbox providers (the tube-pipeline skill's list, plus a few more US ISPs).
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net", "att.net",
  "sbcglobal.net", "bellsouth.net", "verizon.net", "cox.net", "charter.net", "earthlink.net", "frontier.com",
  "windstream.net", "protonmail.com", "proton.me", "mail.com", "gmx.com", "zoho.com", "fastmail.com",
  "q.com", "centurylink.net",
]);

export function emailDomainOf(email: string | null | undefined): string | null {
  const at = (email ?? "").lastIndexOf("@");
  const d = at >= 0 ? (email as string).slice(at + 1).trim().toLowerCase().replace(/\.$/, "") : "";
  return d || null;
}

function cleanDomain(domain: string | null | undefined): string | null {
  const d = (domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return d || null;
}

// True when `email` sits on a business domain that is neither `companyDomain` nor
// a subdomain of it (or it of the email's). False whenever it can't be judged: no
// email, no company domain, or a free mailbox (by our list, or the actor's own
// per-address `free` flag when it gave one).
export function isOtherEmployerEmail(
  email: string | null | undefined,
  companyDomain: string | null | undefined,
  opts: { free?: boolean | null } = {},
): boolean {
  const ed = emailDomainOf(email);
  const cd = cleanDomain(companyDomain);
  if (!ed || !cd) return false;
  if (opts.free === true || FREE_MAIL_DOMAINS.has(ed)) return false;
  return !(ed === cd || ed.endsWith(`.${cd}`) || cd.endsWith(`.${ed}`));
}

// enrichment_data with the address moved out of enrichment.email (where it would
// count as the contact's email) into enrichment.other_employer_email, keeping its
// original provenance block for the owner to see.
export function setAsideOtherEmployerEmail(
  enrichmentData: unknown,
  email: string,
  companyDomain: string,
  now: string,
): Record<string, unknown> {
  const base = enrichmentData && typeof enrichmentData === "object" ? { ...(enrichmentData as Record<string, unknown>) } : {};
  const enr =
    base.enrichment && typeof base.enrichment === "object" ? { ...(base.enrichment as Record<string, unknown>) } : {};
  const { email: found, ...rest } = enr;
  base.enrichment = {
    ...rest,
    other_employer_email: {
      email,
      email_domain: emailDomainOf(email),
      company_domain: companyDomain,
      found: found ?? null,
      set_aside_at: now,
    },
  };
  return base;
}
