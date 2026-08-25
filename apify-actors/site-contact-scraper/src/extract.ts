// Contact extraction from a page's raw HTML — pure, dependency-free, unit-tested.
// Pulls emails (mailto + text), phones (tel + text), socials, and flags
// personEmails whose local part / nearby text matches a target name.

export interface ExtractTarget {
  firstName?: string | null;
  lastName?: string | null;
}

export interface PersonEmail {
  email: string;
  nameMatched: boolean;
}

export interface ExtractedContacts {
  emails: string[]; // every deliverable-looking address (deduped, lowercased)
  companyEmails: string[]; // the role/generic subset (info@, sales@, …)
  personEmails: PersonEmail[]; // non-generic addresses, name-match flagged
  phones: string[]; // normalized display phones
  socials: { linkedin?: string; twitter?: string; facebook?: string; instagram?: string };
}

// Role/department local-parts — company inboxes, never a decision-maker's personal.
const ROLE_LOCALPARTS = new Set([
  "info", "sales", "contact", "contactus", "hello", "hi", "support", "admin",
  "office", "team", "mail", "email", "enquiries", "enquiry", "inquiries", "inquiry",
  "help", "helpdesk", "service", "services", "customerservice", "marketing", "hr",
  "jobs", "careers", "recruiting", "press", "media", "billing", "accounts",
  "accounting", "general", "reception", "webmaster", "noreply", "no-reply",
  "donotreply", "newsletter", "subscribe", "orders", "booking", "bookings",
  "reservations", "quote", "quotes", "estimate", "estimates", "dispatch",
  // System / governance / department inboxes (seen leaking into personEmails):
  "webmasters", "sysadmin", "sysadmins", "postmaster", "hostmaster", "root",
  "abuse", "security", "privacy", "legal", "compliance", "gdpr", "dpo",
  "maintainer", "maintainers", "license", "licensing", "license-violation",
  "assign", "translators", "translations", "web-translators", "feedback",
  "community", "partners", "partnerships", "vendor", "vendors", "procurement",
  "finance", "invoices", "invoice", "unsubscribe", "notifications", "notify",
]);

// Obvious non-addresses / placeholders / asset filenames to drop.
const EMAIL_REJECT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?)$|@(2x|3x|sentry|wixpress|example|domain|yourdomain|email|test)\b|@example\.|@sentry\.|@\dx\b/i;

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
// mailto:/tel: hrefs, tolerant of quotes + query strings.
const MAILTO_RE = /href\s*=\s*["']?\s*mailto:([^"'?>\s]+)/gi;
// tel: values may contain spaces/parens when quoted, so capture up to the quote.
const TEL_RE = /href\s*=\s*["']\s*tel:([^"'>]+)["']/gi;
const SOCIAL_RES: { key: keyof ExtractedContacts["socials"]; re: RegExp }[] = [
  { key: "linkedin", re: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company|pub)\/[a-z0-9\-_%]+/i },
  { key: "twitter", re: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[a-z0-9_]{2,}/i },
  { key: "facebook", re: /https?:\/\/(?:www\.)?facebook\.com\/[a-z0-9.\-]{2,}/i },
  { key: "instagram", re: /https?:\/\/(?:www\.)?instagram\.com\/[a-z0-9_.]{2,}/i },
];

function normName(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Cheap tag strip → visible text, for proximity checks.
function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
}

function isRoleLocalPart(local: string): boolean {
  const l = local.toLowerCase();
  if (ROLE_LOCALPARTS.has(l)) return true;
  // "sales-uk", "info.us", "careers2024" → strip trailing/leading noise and re-check the head.
  const head = l.replace(/[._\-].*$/, "").replace(/\d+$/, "");
  return ROLE_LOCALPARTS.has(head);
}

// Reject date / year-range shapes that masquerade as phones. Copyright spans
// ("© 1996-2026" → 19962026), ISO dates ("2004-02-07" → 20040207), and bare
// YYYYMMDD stamps are the #1 phone false-positives on real contact pages.
function isDateOrYearRange(raw: string): boolean {
  const s = raw.trim();
  if (/(^|\D)(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}(\D|$)/.test(s)) return true; // 1996-2026
  if (/(^|\D)(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])(\D|$)/.test(s)) return true; // 2004-02-07
  const d = s.replace(/\D/g, "");
  if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(d)) return true; // YYYYMMDD
  if (/^(19|20)\d{2}(19|20)\d{2}$/.test(d)) return true; // YYYYYYYY concatenated year range
  return false;
}

// `fromTel` = the number came from a tel: href, i.e. the site itself declared it a
// phone → trusted. Free text needs a genuine phone signal (leading +, parenthesized
// area code, or grouped separators) so we don't ingest IDs, prices, or date stamps.
function normalizePhone(raw: string, fromTel: boolean): string | null {
  if (isDateOrYearRange(raw)) return null;
  const trimmed = raw.replace(/[^\d+]/g, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null; // implausible
  if (!fromTel) {
    const t = raw.trim();
    const hasPlus = t.startsWith("+");
    const hasParens = /\(\s*\d{2,4}\s*\)/.test(t);
    const grouped = /\d[\s.\-]\d/.test(t) && /^\+?\d[\d\s().\-]+\d$/.test(t);
    if (!(hasPlus || hasParens || grouped)) return null; // bare digit run → not a phone
  }
  // Keep a readable form: leading + if present, else the digit string.
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

// Bare registrable domain of an email (host lowercased). Used for same-site trust.
function emailDomain(email: string): string {
  return (email.split("@")[1] || "").toLowerCase();
}

// Is `ed` the same registrable site as `sd` (exact or sub/parent domain)?
function sameSite(ed: string, sd: string): boolean {
  if (!ed || !sd) return false;
  return ed === sd || ed.endsWith(`.${sd}`) || sd.endsWith(`.${ed}`);
}

export function extractContacts(
  html: string,
  target?: ExtractTarget,
  siteDomain?: string | null,
): ExtractedContacts {
  const text = toText(html);
  const first = normName(target?.firstName);
  const last = normName(target?.lastName);
  const hasTarget = first.length >= 2 || last.length >= 2;
  const sd = (siteDomain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

  // ---- emails ----
  const emailSet = new Set<string>();
  const push = (raw: string) => {
    const e = raw.trim().toLowerCase().replace(/^mailto:/, "");
    if (!e || e.length > 254) return;
    if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e)) return;
    if (EMAIL_REJECT.test(e)) return;
    emailSet.add(e);
  };
  for (const m of html.matchAll(MAILTO_RE)) push(decodeURIComponent(m[1]));
  for (const m of text.matchAll(EMAIL_RE)) push(m[0]);

  const emails = Array.from(emailSet).sort();
  const companyEmails: string[] = [];
  const personEmails: PersonEmail[] = [];

  for (const email of emails) {
    const onSite = !sd || sameSite(emailDomain(email), sd);
    const local = email.split("@")[0];
    if (isRoleLocalPart(local)) {
      // A role inbox only counts as THIS company's when it's on-site. An off-domain
      // role address (a partner/vendor linked from the page) is neither ours nor a person.
      if (onSite) companyEmails.push(email);
      continue;
    }
    const nl = normName(local);
    let nameMatched = false;
    if (hasTarget) {
      const localHit =
        (last.length >= 3 && nl.includes(last)) || (first.length >= 3 && nl.includes(first) && (!last || nl.includes(last)));
      // Proximity: the target's full name appears near a mention of the address.
      let proximityHit = false;
      if (!localHit && first && last) {
        const idx = text.toLowerCase().indexOf(email);
        if (idx >= 0) {
          const window = normName(text.slice(Math.max(0, idx - 140), idx + 140));
          proximityHit = window.includes(first) && window.includes(last);
        }
      }
      nameMatched = localHit || proximityHit;
    }
    // On-site personal addresses are kept as-is. Off-domain ones are page noise
    // (third-party embeds, quoted addresses) unless they actually match the target.
    if (onSite || nameMatched) personEmails.push({ email, nameMatched });
  }

  // ---- phones ----
  const phoneSet = new Set<string>();
  const phones: string[] = [];
  const addPhone = (raw: string, fromTel: boolean) => {
    const p = normalizePhone(raw, fromTel);
    if (!p) return;
    const key = p.replace(/\D/g, "");
    if (phoneSet.has(key)) return;
    phoneSet.add(key);
    phones.push(p);
  };
  // tel: hrefs are trusted (the site declared them) and pushed first, so phones[0]
  // — the value the provider writes fill-only to contacts.phone — is the best one.
  for (const m of html.matchAll(TEL_RE)) addPhone(decodeURIComponent(m[1]), true);
  // Text phones: sequences that look like real numbers; gated hard in normalizePhone.
  for (const m of text.matchAll(/(\+?\d[\d\s().\-]{6,}\d)/g)) addPhone(m[0], false);

  // ---- socials ----
  const socials: ExtractedContacts["socials"] = {};
  for (const { key, re } of SOCIAL_RES) {
    const m = html.match(re);
    if (m) socials[key] = m[0];
  }

  return { emails, companyEmails, personEmails, phones, socials };
}
