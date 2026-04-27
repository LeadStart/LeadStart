// Pure validation helpers ported from server/enricher.ts:15-181.
// Catches AI hallucination (invented names, generic emails, business-name
// overlap) and filters tracking-pixel / CDN noise out of scraped emails.

export const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export const GENERIC_EMAIL_PREFIXES = [
  "info", "contact", "office", "hello", "admin", "support",
  "register", "registration", "help", "general", "mail",
  "customercare", "care", "inquiries", "sales", "billing",
  "frontdesk", "front.desk", "reservations", "book", "booking",
  "camp", "programs", "events", "marketing", "media", "press",
  "hr", "jobs", "careers", "volunteer", "donate", "giving",
  "church", "pastor", "prayer", "worship", "connect", "welcome",
  "staff", "team", "ministry", "missions", "outreach",
  "secretary", "receptionist", "membership", "nursery",
  "youth", "children", "kids", "student", "seniors",
  "music", "choir", "bulletin", "newsletter", "communications",
  "service", "enquiries",
];

export const BLOCKED_HOSTNAMES = [
  "localhost", "127.0.0.1", "0.0.0.0",
  "169.254.169.254", "[::1]", "metadata.google.internal",
];

export const JUNK_EMAIL_PATTERNS = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js",
];

export const JUNK_EMAIL_DOMAINS = [
  "sentry.io", "wixpress.com", "cloudflare.com", "googleapis.com",
  "squarespace.com", "w3.org", "schema.org", "sudtipos.com", "contact.tv",
  "example.com", "domain.com", "email.com", "test.com", "yoursite.com",
];

export const COMPANY_WORDS = [
  "llc", "inc", "corp", "company", "companies", "foundation", "association",
  "academy", "school", "camp", "church", "center", "club", "robotics",
  "technologies", "services", "group", "institute",
];

// SSRF guard. Used by both website scraping and the (potential) future
// re-fetch of pages discovered in HTML. Refuses non-http(s), blocks
// loopback / link-local / RFC1918 ranges + cloud metadata endpoints.
export function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.some((b) => hostname === b || hostname.endsWith("." + b))) {
      return false;
    }
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isPersonalEmail(email: string): boolean {
  const prefix = email.split("@")[0].toLowerCase().replace(/[._]/g, "");
  return !GENERIC_EMAIL_PREFIXES.some((gp) => gp.replace(/[._]/g, "") === prefix);
}

export function isJunkEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (lower.length > 50) return true;
  if (JUNK_EMAIL_PATTERNS.some((p) => lower.includes(p))) return true;
  const domain = lower.split("@")[1] || "";
  if (JUNK_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) {
    return true;
  }
  return false;
}

// Heuristic email-to-name match. Catches the eight common conventions
// (john, smith, johnsmith, smithjohn, jsmith, johns, smithj, sjohn).
export function emailMatchesName(
  email: string,
  firstName: string,
  lastName: string,
): boolean {
  if (!firstName || !lastName || !email.includes("@")) return false;
  const localPart = email.split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
  const fn = firstName.toLowerCase().replace(/[^a-z]/g, "");
  const ln = lastName.toLowerCase().replace(/[^a-z]/g, "");
  if (!fn || !ln || fn.length < 2 || ln.length < 2) return false;
  const fi = fn[0];
  const li = ln[0];
  const patterns = [fn, ln, fn + ln, ln + fn, fi + ln, fn + li, ln + fi, li + fn];
  return patterns.some((p) => localPart === p);
}

export function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_REGEX) || [];
  return [...new Set(matches.map((e) => e.toLowerCase()).filter((e) => !isJunkEmail(e)))];
}

export interface ValidatedAiResult {
  firstName: string;
  lastName: string;
  title: string;
  email: string;
}

// Reject AI output that looks invented or hallucinated:
// - missing last name (rejects single-name returns)
// - all words from the business name (rejects "John's Dental" → "John Dental")
// - contains a company word (rejects "Acme LLC" returned as a person)
// - junk email is dropped (kept name; email becomes "")
export function validateAiResult(
  parsed: { first_name?: string; last_name?: string; title?: string; email?: string },
  businessName: string,
): ValidatedAiResult {
  let firstName = (parsed.first_name || "").trim();
  let lastName = (parsed.last_name || "").trim();
  let title = (parsed.title || "").trim();
  let email = (parsed.email || "").trim();

  if (!lastName) {
    return { firstName: "", lastName: "", title: "", email: "" };
  }

  const businessWords = businessName
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const nameWords = `${firstName} ${lastName}`
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const distinctNameWords = new Set(nameWords);

  const hasBusinessOverlap = nameWords.some((nw) =>
    businessWords.some((bw) => bw === nw),
  );
  if (hasBusinessOverlap && distinctNameWords.size < 2) {
    return { firstName: "", lastName: "", title: "", email: "" };
  }

  if (nameWords.some((w) => COMPANY_WORDS.includes(w))) {
    return { firstName: "", lastName: "", title: "", email: "" };
  }

  if (email && isJunkEmail(email)) {
    email = "";
  }

  return { firstName, lastName, title, email };
}
