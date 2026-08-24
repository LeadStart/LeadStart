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

function normalizePhone(raw: string): string | null {
  const trimmed = raw.replace(/[^\d+]/g, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null; // implausible
  // Keep a readable form: leading + if present, else the digit string.
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

export function extractContacts(html: string, target?: ExtractTarget): ExtractedContacts {
  const text = toText(html);
  const first = normName(target?.firstName);
  const last = normName(target?.lastName);
  const hasTarget = first.length >= 2 || last.length >= 2;

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
    const local = email.split("@")[0];
    if (isRoleLocalPart(local)) {
      companyEmails.push(email);
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
    personEmails.push({ email, nameMatched });
  }

  // ---- phones ----
  const phoneSet = new Set<string>();
  const phones: string[] = [];
  const addPhone = (raw: string) => {
    const p = normalizePhone(raw);
    if (!p) return;
    const key = p.replace(/\D/g, "");
    if (phoneSet.has(key)) return;
    phoneSet.add(key);
    phones.push(p);
  };
  for (const m of html.matchAll(TEL_RE)) addPhone(decodeURIComponent(m[1]));
  // Text phones: sequences that look like real numbers (7–15 digits, phone-ish punctuation).
  for (const m of text.matchAll(/(\+?\d[\d\s().\-]{6,}\d)/g)) addPhone(m[0]);

  // ---- socials ----
  const socials: ExtractedContacts["socials"] = {};
  for (const { key, re } of SOCIAL_RES) {
    const m = html.match(re);
    if (m) socials[key] = m[0];
  }

  return { emails, companyEmails, personEmails, phones, socials };
}
